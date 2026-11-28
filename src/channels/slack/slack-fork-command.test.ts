import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { handleSlackEvent, type SlackInboundContext } from "./slack-inbound-handler.js";
import type { SlackMessageEvent, SlackTarget } from "./slack-types.js";

const BOT = "UBOT";
const OWNER = "UOWNER";

function sourceSession(id: string): SessionState {
  const state = createEmptySessionState({ id, workingDir: "/tmp/test", metadata: { slackChannel: true } });
  state.turns = [
    { kind: "user", text: "draft the release note", at: 1 },
    { kind: "assistant_reply", text: "Draft.", at: 2 },
  ];
  state.turnCount = 1;
  state.macroTurnStarts = [2];
  return state;
}

function makeCtx(source: SessionState, key: string, withPostMessage = true) {
  const sessions = new Map([[source.id, source]]);
  const saved: SessionState[] = [];
  const chats = new Map<string, { current: string | null }>([[key, { current: source.id }]]);
  const posted: Array<{ target: SlackTarget; text: string }> = [];
  const postMessage = vi.fn(async (_target: SlackTarget, _text: string) => "99.9");
  const ctx: SlackInboundContext = {
    runtime: {
      runTurn: vi.fn(),
      createSession: vi.fn(),
      sessionStore: {
        load: (id: string) => sessions.get(id) ?? null,
        save: (state: SessionState) => {
          saved.push(state);
          sessions.set(state.id, state);
        },
      },
      turnController: { isBusy: () => false },
    } as never,
    api: {
      postText: vi.fn(async (target: SlackTarget, text: string) => {
        posted.push({ target, text });
      }),
      ...(withPostMessage ? { postMessage } : {}),
    },
    sessions: {
      get: (k: string) => chats.get(k) ?? { current: null },
      setCurrent: vi.fn((k: string, id: string) => {
        chats.set(k, { current: id });
      }),
      rotate: vi.fn(),
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    botUserId: BOT,
    threadReplies: true,
    inflight: new Map(),
    seen: new Set(),
    releaseApprovalSession: vi.fn(),
  };
  return { ctx, saved, chats, posted, postMessage };
}

const mention = (text: string): SlackMessageEvent => ({
  type: "app_mention",
  channel: "C1",
  user: OWNER,
  text: `<@${BOT}> ${text}`,
  ts: "20.1",
});

const dm = (text: string): SlackMessageEvent => ({
  type: "message",
  channel_type: "im",
  channel: "D1",
  user: OWNER,
  text,
  ts: "10.1",
});

describe("!fork on Slack", () => {
  it("in a channel, opens a new thread mapped to a copy and leaves the source alone", async () => {
    const source = sourceSession("s-src");
    const before = structuredClone(source);
    const { ctx, saved, chats, posted, postMessage } = makeCtx(source, "C1:20.1");

    await handleSlackEvent(mention("!fork"), ctx);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toEqual({ channel: "C1" });
    expect(saved).toHaveLength(1);
    const fork = saved[0]!;
    expect(fork.id).not.toBe(source.id);
    expect(fork.turns).toEqual(source.turns);
    expect(fork.metadata.slackChat).toMatchObject({ channel: "C1", threadTs: "99.9" });
    expect(chats.get("C1:99.9")?.current).toBe(fork.id);
    expect(chats.get("C1:20.1")?.current).toBe(source.id);
    expect(source).toEqual(before);
    expect(posted.at(-1)?.text).toContain("new thread");
  });

  it("forks when the @mention comes after the command, with or without a number", async () => {
    for (const text of [`!fork <@${BOT}>`, `!fork 2 <@${BOT}|atomic>`]) {
      const source = sourceSession("s-src");
      source.turns = [
        ...source.turns,
        { kind: "user", text: "make it shorter", at: 3 },
        { kind: "assistant_reply", text: "Shorter.", at: 4 },
      ];
      source.turnCount = 2;
      source.macroTurnStarts = [2, 4];
      const { ctx, saved, posted } = makeCtx(source, "C1:20.1");

      await handleSlackEvent({ type: "app_mention", channel: "C1", user: OWNER, text, ts: "20.1" }, ctx);

      expect(saved, text).toHaveLength(1);
      expect(posted.at(-1)?.text, text).not.toContain("This chat has");
    }
  });

  it("in a DM, moves the conversation to the copy", async () => {
    const source = sourceSession("s-src");
    const { ctx, saved, chats, postMessage } = makeCtx(source, "dm:D1");

    await handleSlackEvent(dm("!fork"), ctx);

    expect(postMessage).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(chats.get("dm:D1")?.current).toBe(saved[0]!.id);
  });

  it("lists !fork in help", async () => {
    const source = sourceSession("s-src");
    const { ctx, posted } = makeCtx(source, "dm:D1");

    await handleSlackEvent(dm("!help"), ctx);

    expect(posted.at(-1)?.text).toContain("!fork");
  });
});
