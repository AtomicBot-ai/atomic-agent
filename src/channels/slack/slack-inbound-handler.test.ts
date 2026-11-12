import { describe, expect, it, vi } from "vitest";

import { handleSlackEvent, refOf, stripMention, type SlackInboundContext } from "./slack-inbound-handler.js";
import type { SlackMessageEvent, SlackTarget } from "./slack-types.js";

const BOT = "UBOT";
const OWNER = "UOWNER";

function fakeSessions() {
  const chats = new Map<string, { current: string | null; history?: string[] }>();
  return {
    chats,
    get: (key: string) => chats.get(key) ?? { current: null },
    setCurrent: vi.fn((key: string, id: string) => {
      chats.set(key, { current: id });
    }),
    rotate: vi.fn((key: string) => {
      const prev = chats.get(key);
      if (prev?.current) chats.set(key, { current: null, history: [prev.current] });
    }),
  };
}

function makeCtx(over: Partial<SlackInboundContext> = {}) {
  const posted: Array<{ target: SlackTarget; text: string }> = [];
  let n = 0;
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "**done**" } });
    return {};
  });
  const sessions = fakeSessions();
  const ctx: SlackInboundContext = {
    runtime: {
      runTurn,
      createSession: vi.fn(() => ({ id: `s${++n}` })),
      sessionStore: { load: (id: string) => ({ id }) },
    } as never,
    api: {
      postText: vi.fn(async (target: SlackTarget, text: string) => {
        posted.push({ target, text });
      }),
    },
    sessions: sessions as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    botUserId: BOT,
    threadReplies: true,
    inflight: new Map(),
    seen: new Set(),
    ensureApprovalSession: vi.fn(),
    releaseApprovalSession: vi.fn(),
    ...over,
  };
  return { ctx, posted, runTurn, sessions };
}

function dm(text: string, over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return { type: "message", channel_type: "im", channel: "D1", user: OWNER, text, ts: "10.1", ...over };
}

function mention(text: string, over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return { type: "app_mention", channel: "C1", user: OWNER, text: `<@${BOT}> ${text}`, ts: "20.1", ...over };
}

describe("handleSlackEvent", () => {
  it("runs a DM through the agent and replies in mrkdwn in the thread", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    await handleSlackEvent(dm("hello"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toBe("hello");
    expect(posted).toEqual([{ target: { channel: "D1", threadTs: "10.1" }, text: "*done*" }]);
  });

  it("runs the turn with the slack origin and a chat answer style", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent(dm("hello"), ctx);
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "slack", answerChannel: "telegram" });
  });

  it("strips the mention and answers in the channel thread", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    await handleSlackEvent(mention("build it", { thread_ts: "19.0" }), ctx);
    expect(runTurn.mock.calls[0]?.[1]).toBe("build it");
    expect(posted[0]?.target).toEqual({ channel: "C1", threadTs: "19.0" });
  });

  it("refuses everyone when no owner is configured", async () => {
    const { ctx, runTurn, posted } = makeCtx({ ownerIds: [] });
    await handleSlackEvent(dm("hello"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it("ignores non-owners, bots, subtypes and its own messages", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent(dm("x", { user: "USTRANGER" }), ctx);
    await handleSlackEvent(dm("x", { bot_id: "B1", ts: "1" }), ctx);
    await handleSlackEvent(dm("x", { subtype: "message_changed", ts: "2" }), ctx);
    await handleSlackEvent(dm("x", { user: BOT, ts: "3" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("ignores plain channel messages that do not mention the bot", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent({ ...dm("x"), channel_type: "channel", channel: "C1" }, ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("runs a redelivered event only once", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent(dm("hello"), ctx);
    await handleSlackEvent(dm("hello"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps one session per DM and one per channel thread", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent(dm("a", { ts: "1" }), ctx);
    await handleSlackEvent(dm("b", { ts: "2" }), ctx);
    await handleSlackEvent(mention("c", { ts: "3" }), ctx);
    await handleSlackEvent(mention("d", { ts: "4" }), ctx);
    const ids = runTurn.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["s1", "s1", "s2", "s3"]);
  });

  it("binds approvals to the reply thread before the turn runs", async () => {
    const { ctx } = makeCtx();
    await handleSlackEvent(mention("go"), ctx);
    expect(ctx.ensureApprovalSession).toHaveBeenCalledWith("s1", { channel: "C1", threadTs: "20.1" });
  });

  it("!new rotates the session and !status reports it", async () => {
    const { ctx, posted, sessions } = makeCtx();
    await handleSlackEvent(dm("hello", { ts: "1" }), ctx);
    await handleSlackEvent(dm("!status", { ts: "2" }), ctx);
    expect(posted.at(-1)?.text).toMatch(/session `s1`/);
    await handleSlackEvent(dm("!new", { ts: "3" }), ctx);
    expect(sessions.rotate).toHaveBeenCalledWith("dm:D1");
    expect(ctx.releaseApprovalSession).toHaveBeenCalledWith("s1");
    expect(posted.at(-1)?.text).toMatch(/new session/);
  });

  it("!cancel aborts the turn in flight", async () => {
    const { ctx, posted } = makeCtx();
    const controller = new AbortController();
    ctx.inflight.set("dm:D1", controller);
    await handleSlackEvent(dm("!cancel"), ctx);
    expect(controller.signal.aborted).toBe(true);
    expect(posted.at(-1)?.text).toMatch(/Cancelling/);
  });

  it("sends an unknown !word to the agent as text", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSlackEvent(dm("!important: fix the build"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("reports a failed turn with a scrubbed reason", async () => {
    const { ctx, posted } = makeCtx({
      runtime: {
        runTurn: vi.fn(async () => {
          throw new Error("boom with xoxb-111-222-abc");
        }),
        createSession: () => ({ id: "s1" }),
        sessionStore: { load: () => null },
      } as never,
    });
    await handleSlackEvent(dm("hello"), ctx);
    expect(posted.at(-1)?.text).toMatch(/^Turn failed: boom with <token>/);
  });

  it("never throws, even when posting fails", async () => {
    const { ctx } = makeCtx({
      api: {
        postText: vi.fn(async () => {
          throw new Error("down");
        }),
      },
    });
    await expect(handleSlackEvent(dm("hello"), ctx)).resolves.toBeUndefined();
  });
});

describe("refOf", () => {
  it("replies top-level and shares a channel session when threadReplies is off", () => {
    const ref = refOf(mention("x"), false, false);
    expect(ref.key).toBe("C1");
    expect(ref.target).toEqual({ channel: "C1" });
  });

  it("still answers inside an existing thread when threadReplies is off", () => {
    const ref = refOf(mention("x", { thread_ts: "19.0" }), false, false);
    expect(ref.key).toBe("C1:19.0");
    expect(ref.target).toEqual({ channel: "C1", threadTs: "19.0" });
  });
});

describe("stripMention", () => {
  it("removes only a leading mention of the bot", () => {
    expect(stripMention(`<@${BOT}> hi`, BOT)).toBe(" hi");
    expect(stripMention(`<@${BOT}|bot> hi`, BOT)).toBe(" hi");
    expect(stripMention(`ask <@${BOT}> later`, BOT)).toBe(`ask <@${BOT}> later`);
  });
});
