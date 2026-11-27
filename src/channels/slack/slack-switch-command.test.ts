import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { handleSlackEvent, type SlackInboundContext } from "./slack-inbound-handler.js";
import type { SlackMessageEvent, SlackTarget } from "./slack-types.js";

const BOT = "UBOT";
const OWNER = "UOWNER";

function session(id: string, metadata: Record<string, unknown>): SessionState {
  const state = createEmptySessionState({ id, workingDir: "/tmp/test", metadata });
  state.turns = [
    { kind: "user", text: "draft the release note", at: 1 },
    { kind: "assistant_reply", text: "Draft.", at: 2 },
  ];
  state.turnCount = 1;
  state.macroTurnStarts = [2];
  return state;
}

function makeCtx(initial: SessionState[], chats: Map<string, { current: string | null; label?: string }>) {
  const sessions = new Map(initial.map((s) => [s.id, s]));
  const posted: string[] = [];
  const busy = new Set<string>();
  const ctx: SlackInboundContext = {
    runtime: {
      runTurn: vi.fn(),
      createSession: vi.fn(),
      sessionStore: {
        load: (id: string) => sessions.get(id) ?? null,
        save: (state: SessionState) => sessions.set(state.id, state),
      },
      turnController: { isBusy: (id: string) => busy.has(id) },
    } as never,
    api: {
      postText: vi.fn(async (_target: SlackTarget, text: string) => {
        posted.push(text);
      }),
    },
    sessions: {
      get: (k: string) => chats.get(k) ?? { current: null },
      entries: () => [...chats.entries()].map(([chatKey, entry]) => ({ chatKey, entry })),
      setCurrent: vi.fn((k: string, id: string, label?: string) => {
        chats.set(k, { current: id, ...(label ? { label } : {}) });
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
  return { ctx, posted, busy };
}

let ts = 0;
const dm = (text: string): SlackMessageEvent => ({
  type: "message",
  channel_type: "im",
  channel: "D1",
  user: OWNER,
  text,
  ts: `10.${++ts}`,
});

describe("!switch on Slack (ATO-2456)", () => {
  it("after a DM fork, !switch <source> takes the DM back to the original", async () => {
    const source = session("s-src", { slackChannel: true });
    const chats = new Map([["dm:D1", { current: source.id as string | null }]]);
    const { ctx, posted } = makeCtx([source], chats);

    await handleSlackEvent(dm("!fork"), ctx);
    const fork = chats.get("dm:D1")!.current!;
    expect(fork).not.toBe(source.id);
    expect(posted.at(-1)).toContain("!switch s-src");

    await handleSlackEvent(dm("!switch s-src"), ctx);
    expect(chats.get("dm:D1")!.current).toBe(source.id);
    expect(posted.at(-1)).toContain(`Previous session \`${fork}\` archived`);
    expect(ctx.runtime.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a session from another surface", async () => {
    const tui = session("s-tui", {});
    const chats = new Map([["dm:D1", { current: null as string | null }]]);
    const { ctx, posted } = makeCtx([tui], chats);

    await handleSlackEvent(dm("!switch s-tui"), ctx);

    expect(chats.get("dm:D1")!.current).toBeNull();
    expect(posted.at(-1)).toContain("another surface");
  });

  it("refuses a session another conversation is on", async () => {
    const other = session("s-other", { slackChannel: true });
    const chats = new Map<string, { current: string | null; label?: string }>([
      ["dm:D1", { current: null }],
      ["C1:5.5", { current: "s-other", label: "channel C1" }],
    ]);
    const { ctx, posted } = makeCtx([other], chats);

    await handleSlackEvent(dm("!switch s-other"), ctx);

    expect(chats.get("dm:D1")!.current).toBeNull();
    expect(posted.at(-1)).toContain("active in another conversation");
  });

  it("refuses while that session runs a turn, and asks for an id without one", async () => {
    const target = session("s-busy", { slackChannel: true });
    const chats = new Map([["dm:D1", { current: null as string | null }]]);
    const { ctx, posted, busy } = makeCtx([target], chats);
    busy.add("s-busy");

    await handleSlackEvent(dm("!switch s-busy"), ctx);
    expect(posted.at(-1)).toContain("turn in progress");

    await handleSlackEvent(dm("!switch"), ctx);
    expect(posted.at(-1)).toContain("Usage: `!switch <session-id>`");
    expect(chats.get("dm:D1")!.current).toBeNull();
  });

  it("lists !switch in help", async () => {
    const { ctx, posted } = makeCtx([], new Map());
    await handleSlackEvent(dm("!help"), ctx);
    expect(posted.at(-1)).toContain("!switch");
  });
});
