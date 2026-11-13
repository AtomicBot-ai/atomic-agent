import { describe, expect, it, vi } from "vitest";

import { handleTeamsActivity, stripBotMention, type TeamsInboundContext } from "./msteams-inbound-handler.js";
import type { TeamsActivity, TeamsTarget } from "./msteams-types.js";

const BOT = "28:bot-app-id";
const OWNER = "aad-owner";
const SERVICE = "https://smba.invalid/emea/";

function fakeSessions() {
  const chats = new Map<string, { current: string | null }>();
  return {
    get: (key: string) => chats.get(key) ?? { current: null },
    setCurrent: vi.fn((key: string, id: string) => {
      chats.set(key, { current: id });
    }),
    rotate: vi.fn((key: string) => {
      chats.set(key, { current: null });
    }),
  };
}

function makeCtx(over: Partial<TeamsInboundContext> = {}) {
  const posted: Array<{ target: TeamsTarget; text: string }> = [];
  let n = 0;
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
    return {};
  });
  const bridge = {
    handleSubmit: vi.fn(async () => "Approved."),
    tryAnswer: vi.fn(async () => null),
    pendingIn: vi.fn(() => 0),
  };
  const ctx: TeamsInboundContext = {
    runtime: {
      runTurn,
      createSession: vi.fn(() => ({ id: `s${++n}` })),
      sessionStore: { load: (id: string) => ({ id }) },
    } as never,
    api: {
      postText: vi.fn(async (target: TeamsTarget, text: string) => {
        posted.push({ target, text });
      }),
    },
    sessions: fakeSessions() as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    bridge,
    inflight: new Map(),
    seen: new Set(),
    ensureApprovalSession: vi.fn(),
    releaseApprovalSession: vi.fn(),
    ...over,
  };
  return { ctx, posted, runTurn, bridge };
}

let seq = 0;
function personal(text: string, over: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: `m${++seq}`,
    channelId: "msteams",
    serviceUrl: SERVICE,
    text,
    from: { id: "29:user", aadObjectId: OWNER },
    recipient: { id: BOT },
    conversation: { id: "a:personal-1", conversationType: "personal" },
    ...over,
  };
}

function channelMsg(text: string, mention: boolean, over: Partial<TeamsActivity> = {}): TeamsActivity {
  return personal(mention ? `<at>Atomic</at> ${text}` : text, {
    conversation: { id: "19:abc@thread.tacv2;messageid=7", conversationType: "channel" },
    ...(mention ? { entities: [{ type: "mention", text: "<at>Atomic</at>", mentioned: { id: BOT } }] } : {}),
    ...over,
  });
}

describe("handleTeamsActivity", () => {
  it("runs a personal chat message through the agent with the msteams origin", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    await handleTeamsActivity(personal("hello"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toBe("hello");
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "msteams" });
    expect(posted).toEqual([{ target: { serviceUrl: SERVICE, conversationId: "a:personal-1" }, text: "done" }]);
  });

  it("ignores a channel message that does not mention the bot", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleTeamsActivity(channelMsg("build it", false), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("strips the mention in a channel and replies in the thread", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    const msg = channelMsg("build it", true);
    await handleTeamsActivity(msg, ctx);
    expect(runTurn.mock.calls[0]?.[1]).toBe("build it");
    expect(posted[0]?.target).toEqual({ serviceUrl: SERVICE, conversationId: "19:abc@thread.tacv2;messageid=7", replyToId: msg.id });
  });

  it("ignores a non-owner and refuses everyone when no owner is configured", async () => {
    const a = makeCtx();
    await handleTeamsActivity(personal("hi", { from: { id: "29:x", aadObjectId: "aad-stranger" } }), a.ctx);
    expect(a.runTurn).not.toHaveBeenCalled();
    expect(a.posted).toEqual([]);
    const b = makeCtx({ ownerIds: [] });
    await handleTeamsActivity(personal("hi"), b.ctx);
    expect(b.runTurn).not.toHaveBeenCalled();
  });

  it("routes an owner's card click to the bridge and posts its answer", async () => {
    const { ctx, posted, bridge, runTurn } = makeCtx();
    await handleTeamsActivity(personal("", { value: { atomicApproval: "appr-1", verdict: "yes" } }), ctx);
    expect(bridge.handleSubmit).toHaveBeenCalledWith({ atomicApproval: "appr-1", verdict: "yes" }, OWNER, "a:personal-1");
    expect(posted[0]?.text).toBe("Approved.");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("never lets a non-owner's card click reach the bridge", async () => {
    const { ctx, bridge } = makeCtx();
    await handleTeamsActivity(
      personal("", { from: { id: "29:x", aadObjectId: "aad-stranger" }, value: { atomicApproval: "appr-1", verdict: "yes" } }),
      ctx,
    );
    expect(bridge.handleSubmit).not.toHaveBeenCalled();
  });

  it("runs a redelivered activity once and ignores the bot's own messages", async () => {
    const { ctx, runTurn } = makeCtx();
    const msg = personal("once");
    await handleTeamsActivity(msg, ctx);
    await handleTeamsActivity(msg, ctx);
    await handleTeamsActivity(personal("echo", { from: { id: BOT, aadObjectId: OWNER } }), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("answers /status and /new without a turn", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    await handleTeamsActivity(personal("hello"), ctx);
    await handleTeamsActivity(personal("/status"), ctx);
    await handleTeamsActivity(personal("/new"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(posted[1]?.text).toContain("session `s1`");
    expect(posted[2]?.text).toContain("Started a new session");
  });

  it("ignores activities that are not messages", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleTeamsActivity(personal("hi", { type: "conversationUpdate" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("stripBotMention", () => {
  it("removes only the bot's mention and decodes &nbsp;", () => {
    const a: TeamsActivity = {
      text: "<at>Atomic</at>&nbsp;ask <at>Bob</at>",
      entities: [
        { type: "mention", text: "<at>Atomic</at>", mentioned: { id: BOT } },
        { type: "mention", text: "<at>Bob</at>", mentioned: { id: "29:bob" } },
      ],
    };
    expect(stripBotMention(a, BOT)).toBe("ask <at>Bob</at>");
  });
});
