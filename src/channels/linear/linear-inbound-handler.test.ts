import { describe, expect, it, vi } from "vitest";

import { handleLinearEvent, type LinearInboundContext } from "./linear-inbound-handler.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import { LinearTurnQueue } from "./linear-turn-queue.js";
import type { LinearTarget, LinearWebhookPayload } from "./linear-types.js";

const OWNER = "u-owner";
const BOT = "u-bot";

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

function makeCtx(over: Partial<LinearInboundContext> = {}, replyText = "Here is the summary.") {
  const posted: Array<{ target: LinearTarget; body: string }> = [];
  let n = 0;
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: replyText } });
    return {};
  });
  const own = new LinearOwnComments();
  const ctx: LinearInboundContext = {
    runtime: {
      runTurn,
      createSession: vi.fn(() => ({ id: `s${++n}` })),
      sessionStore: { load: (id: string) => ({ id }) },
    } as never,
    post: vi.fn(async (target: LinearTarget, body: string) => {
      own.notePending(body);
      posted.push({ target, body });
    }),
    sessions: fakeSessions() as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    handles: ["agent"],
    viewerId: BOT,
    onAssign: true,
    own,
    bridge: null,
    turns: new LinearTurnQueue(),
    seen: new Set(),
    ensureApprovalSession: vi.fn(),
    ...over,
  };
  return { ctx, posted, runTurn, own };
}

let seq = 0;
function comment(body: string, over: Record<string, unknown> = {}): LinearWebhookPayload {
  const id = `c${++seq}`;
  return {
    type: "Comment",
    action: "create",
    url: `https://linear.app/acme/issue/ENG-7#comment-${id}`,
    actor: { id: OWNER, name: "Nadia", type: "user" },
    webhookTimestamp: Date.now(),
    data: { id, body, issueId: "issue-7", userId: OWNER, issue: { id: "issue-7", identifier: "ENG-7", title: "Login breaks" }, ...over },
  };
}

describe("handleLinearEvent: comments", () => {
  it("runs a mention through the agent and replies in the same thread", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    const event = comment("@agent summarize this issue");
    await handleLinearEvent(event, ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    const prompt = runTurn.mock.calls[0]![1];
    expect(prompt).toContain("[Linear issue ENG-7: Login breaks]");
    expect(prompt).toContain("summarize this issue");
    expect(prompt).not.toContain("@agent");
    expect(runTurn.mock.calls[0]![2]).toMatchObject({ origin: "linear" });
    const id = (event.data as { id: string }).id;
    expect(posted).toEqual([{ target: { issueId: "issue-7", parentId: id }, body: "Here is the summary." }]);
  });

  it("replies under the thread root when the mention is itself a reply", async () => {
    const { ctx, posted } = makeCtx();
    await handleLinearEvent(comment("@agent and this?", { parentId: "c-root" }), ctx);
    expect(posted[0]?.target).toEqual({ issueId: "issue-7", parentId: "c-root" });
  });

  it("ignores comments without a mention", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleLinearEvent(comment("looks good to me"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("drops a mention from a non-owner and logs their user id", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleLinearEvent(comment("@agent delete everything", { userId: "u-stranger" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "linear: dropping mention from non-owner",
      expect.objectContaining({ userId: "u-stranger" }),
    );
  });

  it("ignores a comment it posted, matched by id, even when it mentions the handle (loop guard)", async () => {
    // Personal key: the agent posts as the owner, so only the guard stops the echo.
    const { ctx, runTurn, own } = makeCtx({ viewerId: OWNER });
    own.notePosted("c-posted");
    await handleLinearEvent(comment("@agent again", { id: "c-posted" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("ignores the echo of its reply that arrives before commentCreate returned (matched by body)", async () => {
    const reply = "Done. Ping @agent if CI fails again.";
    const { ctx, runTurn } = makeCtx({ viewerId: OWNER }, reply);
    await handleLinearEvent(comment("@agent check CI"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    await handleLinearEvent(comment(reply), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    // The same words typed by someone else (not the key's user) still count.
    const other = makeCtx({ viewerId: BOT, ownerIds: [OWNER] }, reply);
    other.own.notePending(reply);
    await handleLinearEvent(comment(reply), other.ctx);
    expect(other.runTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores comments written by an app", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleLinearEvent(comment("@agent hi", { botActor: { name: "GitHub" } }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("keeps one session per issue across mentions, and separate issues apart", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleLinearEvent(comment("@agent first"), ctx);
    await handleLinearEvent(comment("@agent second"), ctx);
    await handleLinearEvent(comment("@agent other issue", { issueId: "issue-9", issue: { identifier: "ENG-9" } }), ctx);
    const ids = runTurn.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ctx.runtime.createSession).toHaveBeenCalledTimes(2);
  });

  it("runs a redelivered comment once", async () => {
    const { ctx, runTurn } = makeCtx();
    const event = comment("@agent once");
    await handleLinearEvent(event, ctx);
    await handleLinearEvent(event, ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("settles an approval answer from an owner without a mention", async () => {
    const tryAnswer = vi.fn(() => "Approved.");
    const { ctx, runTurn, posted } = makeCtx({ bridge: { tryAnswer, pendingIn: () => 0 } });
    await handleLinearEvent(comment("yes ABCD"), ctx);
    expect(tryAnswer).toHaveBeenCalledWith("issue-7", "yes ABCD");
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted[0]?.body).toBe("Approved.");
  });

  it.each(["yes ABCD", "always ABCD"])("does not let a non-owner settle an approval with %j", async (body) => {
    const tryAnswer = vi.fn(() => "Approved.");
    const { ctx, runTurn, posted } = makeCtx({ bridge: { tryAnswer, pendingIn: () => 0 } });
    await handleLinearEvent(comment(body, { userId: "u-stranger" }), ctx);
    expect(tryAnswer).not.toHaveBeenCalled();
    expect(ctx.post).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("handleLinearEvent: assignment", () => {
  function assigned(over: Partial<LinearWebhookPayload> = {}): LinearWebhookPayload {
    return {
      type: "Issue",
      action: "update",
      actor: { id: OWNER },
      webhookTimestamp: ++seq,
      updatedFrom: { assigneeId: null },
      data: { id: "issue-3", identifier: "ENG-3", title: "Add dark mode", description: "Both themes.", assigneeId: BOT },
      ...over,
    };
  }

  it("starts work when an owner assigns the issue to the agent, replying top-level", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleLinearEvent(assigned(), ctx);
    expect(runTurn.mock.calls[0]![1]).toContain("[Linear issue ENG-3: Add dark mode] was assigned to you.");
    expect(posted[0]?.target).toEqual({ issueId: "issue-3" });
  });

  it("ignores other edits, other assignees, non-owners and onAssign off", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleLinearEvent(assigned({ updatedFrom: { title: "old" } }), ctx);
    await handleLinearEvent(assigned({ data: { id: "issue-3", assigneeId: "u-other" } }), ctx);
    await handleLinearEvent(assigned({ actor: { id: "u-stranger" } }), ctx);
    const off = makeCtx({ onAssign: false });
    await handleLinearEvent(assigned(), off.ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(off.runTurn).not.toHaveBeenCalled();
  });
});

describe("handleLinearEvent: commands (ATO-2464)", () => {
  it("answers @agent /status without running a turn", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleLinearEvent(comment("@agent first"), ctx);
    await handleLinearEvent(comment("@agent /status"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(posted[1]?.body).toMatch(/^This issue is on session `s1`\. Idle\.$/);
  });

  it("@agent /new archives the issue's session so the next mention starts fresh", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleLinearEvent(comment("@agent first"), ctx);
    await handleLinearEvent(comment("@agent /new"), ctx);
    await handleLinearEvent(comment("@agent second"), ctx);
    expect(posted[1]?.body).toContain("Previous session `s1` archived");
    const ids = runTurn.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("a lone 'stop' after the mention cancels instead of queueing a turn", async () => {
    let release: () => void = () => {};
    const { ctx, runTurn, posted } = makeCtx();
    runTurn.mockImplementationOnce(
      (_s: unknown, _t: string, opts: { signal?: AbortSignal; eventHook?: (e: unknown) => void }) =>
        new Promise((resolve) => {
          opts.eventHook?.({ type: "step_started" });
          release = () => resolve({});
          opts.signal?.addEventListener("abort", () => resolve({}));
        }),
    );
    const running = handleLinearEvent(comment("@agent long job"), ctx);
    await vi.waitFor(() => expect(ctx.turns.busy("issue-7")).toBe(true));
    await handleLinearEvent(comment("@agent stop"), ctx);
    await running;
    release();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(posted.map((p) => p.body)).toEqual(["Cancelling the current request.", "Turn cancelled."]);
  });

  it("does not treat a request that starts with a command word as a command", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleLinearEvent(comment("@agent stop the deploy and report"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("handleLinearEvent: queue while busy (ATO-2464)", () => {
  it("queues a second mention on a busy issue instead of refusing it", async () => {
    let release: () => void = () => {};
    const { ctx, runTurn, posted } = makeCtx();
    runTurn.mockImplementationOnce(
      (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) =>
        new Promise((resolve) => {
          release = () => {
            opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "first answer" } });
            resolve({});
          };
        }),
    );
    const first = handleLinearEvent(comment("@agent first"), ctx);
    await vi.waitFor(() => expect(ctx.turns.busy("issue-7")).toBe(true));
    const second = handleLinearEvent(comment("@agent second"), ctx);
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
    const bodies = posted.map((p) => p.body);
    expect(bodies[0]).toMatch(/^Queued:/);
    expect(bodies).toContain("first answer");
    expect(bodies).toContain("Here is the summary.");
    expect(bodies.some((b) => b.startsWith("I am already working"))).toBe(false);
  });
});

describe("handleLinearEvent: attachments (ATO-2464)", () => {
  it("downloads a Linear upload and hands the agent its local path", async () => {
    const save = vi.fn(async (input: { name?: string; bytes: Uint8Array }) => ({
      path: `/state/inbox/linear/2026-11-27/120000-${input.name}`,
      name: input.name ?? "x",
      bytes: input.bytes.byteLength,
      mimeType: "image/png",
    }));
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }));
    const { ctx, runTurn } = makeCtx({ attachments: { inbox: { dir: "/state/inbox/linear", save }, download } });
    await handleLinearEvent(comment("@agent what is wrong here? ![shot.png](https://uploads.linear.app/a/b/shot.png)"), ctx);
    expect(download).toHaveBeenCalledWith("https://uploads.linear.app/a/b/shot.png");
    const prompt = runTurn.mock.calls[0]![1];
    expect(prompt).toContain("[attachments]");
    expect(prompt).toContain("/state/inbox/linear/2026-11-27/120000-shot.png");
  });
});
