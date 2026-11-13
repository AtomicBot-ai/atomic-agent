import { describe, expect, it, vi } from "vitest";

import { GOOGLE_CHAT_HELP_TEXT } from "./googlechat-commands.js";
import type { GoogleChatEvent, GoogleChatUser } from "./googlechat-events.js";
import { handleGoogleChatEvent, type GoogleChatInboundContext } from "./googlechat-inbound-handler.js";
import { isGoogleChatOwner } from "./googlechat-types.js";

const OWNER = "users/111";
const SPACE = "spaces/AAA";
const THREAD = "spaces/AAA/threads/t1";

function fakeSessions(seed: Record<string, string | null> = {}) {
  const chats = new Map<string, { current: string | null }>(
    Object.entries(seed).map(([k, v]) => [k, { current: v }]),
  );
  return {
    get: (key: string) => chats.get(key) ?? { current: null },
    entries: () => [...chats.entries()].map(([chatKey, entry]) => ({ chatKey, entry })),
    setCurrent: vi.fn((key: string, id: string) => {
      chats.set(key, { current: id });
    }),
    rotate: vi.fn((key: string) => {
      chats.set(key, { current: null });
    }),
  };
}

function makeCtx(over: Partial<GoogleChatInboundContext> = {}, reply = "done") {
  const posts: Array<{ space: string; text: string; thread?: string }> = [];
  const runTurn = vi.fn(
    async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
      opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: reply } });
      return {};
    },
  );
  const ownerIds = [OWNER, "ada@example.com"];
  const ctx: GoogleChatInboundContext = {
    runtime: {
      runTurn,
      createSession: vi.fn(() => ({ id: "s-new" })),
      sessionStore: { load: vi.fn((id: string) => (id === "s-old" ? { id } : null)) },
    } as never,
    post: vi.fn(async (space: string, text: string, thread?: string) => {
      posts.push({ space, text, ...(thread ? { thread } : {}) });
    }),
    sessions: fakeSessions(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    isOwner: (user) => isGoogleChatOwner(ownerIds, user),
    ownerConfigured: true,
    inflight: new Map(),
    bridge: { tryAnswer: vi.fn(() => null), pendingIn: vi.fn(() => 0) },
    ensureApprovalSession: vi.fn(),
    releaseApprovalSession: vi.fn(),
    noteThread: vi.fn(),
    ...over,
  };
  return { ctx, posts, runTurn };
}

function message(text: string, user: GoogleChatUser = { name: OWNER, type: "HUMAN" }): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: SPACE, spaceType: "DIRECT_MESSAGE" },
    message: { name: `${SPACE}/messages/m1`, text: `@Agent ${text}`, argumentText: ` ${text}`, thread: { name: THREAD } },
    user,
  };
}

describe("handleGoogleChatEvent", () => {
  it("runs an owner's message as a turn and replies in its thread", async () => {
    const { ctx, posts, runTurn } = makeCtx();
    await handleGoogleChatEvent(message("list files"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    const prompt = runTurn.mock.calls[0]?.[1] as string;
    expect(prompt.split("\n")[0]).toBe(`[from] platform=googlechat user=${OWNER} chat=${SPACE}`);
    expect(prompt.split("\n")[1]).toBe("list files");
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "googlechat" });
    expect(ctx.runtime.createSession).toHaveBeenCalledWith({
      metadata: { googleChatChannel: true, googleChat: { space: SPACE } },
    });
    expect(ctx.ensureApprovalSession).toHaveBeenCalledWith("s-new", SPACE);
    expect(ctx.noteThread).toHaveBeenCalledWith(SPACE, THREAD);
    expect(posts).toEqual([{ space: SPACE, text: "done", thread: THREAD }]);
    expect(ctx.inflight.size).toBe(0);
  });

  it("accepts an owner listed by email", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleGoogleChatEvent(message("hi", { name: "users/222", email: "Ada@Example.com", type: "HUMAN" }), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("continues the space's stored session", async () => {
    const { ctx, runTurn } = makeCtx({ sessions: fakeSessions({ [SPACE]: "s-old" }) });
    await handleGoogleChatEvent(message("again"), ctx);
    expect((runTurn.mock.calls[0]?.[0] as { id: string }).id).toBe("s-old");
    expect(ctx.runtime.createSession).not.toHaveBeenCalled();
  });

  it("ignores non-owners, other apps and card clicks without replying", async () => {
    const { ctx, runTurn, posts } = makeCtx();
    await handleGoogleChatEvent(message("hi", { name: "users/999", type: "HUMAN" }), ctx);
    await handleGoogleChatEvent(message("hi", { name: OWNER, type: "BOT" }), ctx);
    await handleGoogleChatEvent({ ...message("hi"), type: "CARD_CLICKED" }, ctx);
    await handleGoogleChatEvent({ ...message("hi"), space: { name: "spaces/../x" } }, ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it("refuses everything when no owner is configured", async () => {
    const { ctx, runTurn } = makeCtx({ isOwner: () => false, ownerConfigured: false });
    await handleGoogleChatEvent(message("hi"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("greets an owner who adds the app, and stays silent for anyone else", async () => {
    const { ctx, posts, runTurn } = makeCtx();
    await handleGoogleChatEvent({ type: "ADDED_TO_SPACE", space: { name: SPACE }, user: { name: OWNER } }, ctx);
    await handleGoogleChatEvent({ type: "ADDED_TO_SPACE", space: { name: SPACE }, user: { name: "users/9" } }, ctx);
    expect(posts).toEqual([{ space: SPACE, text: GOOGLE_CHAT_HELP_TEXT }]);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("settles an approval answer instead of running a turn", async () => {
    const { ctx, posts, runTurn } = makeCtx({
      bridge: { tryAnswer: vi.fn(() => "Approved."), pendingIn: vi.fn(() => 1) },
    });
    await handleGoogleChatEvent(message("yes abc123"), ctx);
    expect(ctx.bridge.tryAnswer).toHaveBeenCalledWith(SPACE, { name: OWNER, type: "HUMAN" }, "yes abc123");
    expect(runTurn).not.toHaveBeenCalled();
    expect(posts).toEqual([{ space: SPACE, text: "Approved.", thread: THREAD }]);
  });

  it("answers /help and /status without a turn", async () => {
    const { ctx, posts, runTurn } = makeCtx();
    await handleGoogleChatEvent(message("/help"), ctx);
    await handleGoogleChatEvent(message("/status"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posts[0]?.text).toBe(GOOGLE_CHAT_HELP_TEXT);
    expect(posts[1]?.text).toContain("No session for this space yet.");
  });

  it("splits a long reply into chunks under the limit", async () => {
    const long = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    const { ctx, posts } = makeCtx({}, long);
    await handleGoogleChatEvent(message("write a lot"), ctx);
    expect(posts.map((p) => p.text)).toEqual(["a".repeat(3000), "b".repeat(3000)]);
  });

  it("answers files with a notice instead of a turn", async () => {
    const { ctx, posts, runTurn } = makeCtx();
    const event = message("see this");
    event.message = { ...event.message, attachment: [{ name: "x" }] };
    await handleGoogleChatEvent(event, ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posts[0]?.text).toMatch(/Files are not supported/);
  });

  it("never throws, even when posting fails", async () => {
    const { ctx } = makeCtx({ post: vi.fn(async () => Promise.reject(new Error("Bearer ya29.x"))) });
    await expect(handleGoogleChatEvent(message("hi"), ctx)).resolves.toBeUndefined();
  });
});
