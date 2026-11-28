import { describe, expect, it, vi } from "vitest";

import { LINEAR_AGENT_NOT_OWNER, stripLeadingMention } from "./linear-agent-session.js";
import { handleLinearEvent, type LinearInboundContext } from "./linear-inbound-handler.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import { LinearTurnQueue } from "./linear-turn-queue.js";
import type { LinearTarget, LinearWebhookPayload } from "./linear-types.js";

const OWNER = "u-owner";

function makeCtx(over: Partial<LinearInboundContext> = {}) {
  const posted: Array<{ target: LinearTarget; body: string; kind?: string }> = [];
  const chats = new Map<string, string | null>();
  let n = 0;
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "Fixed in the PR." } });
    return {};
  });
  const ctx: LinearInboundContext = {
    runtime: { runTurn, createSession: vi.fn(() => ({ id: `s${++n}` })), sessionStore: { load: (id: string) => ({ id }) } } as never,
    post: vi.fn(async (target: LinearTarget, body: string, kind?: string) => {
      posted.push({ target, body, ...(kind ? { kind } : {}) });
    }),
    sessions: {
      get: (k: string) => ({ current: chats.get(k) ?? null }),
      setCurrent: (k: string, id: string) => chats.set(k, id),
      rotate: (k: string) => chats.set(k, null),
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    handles: ["agent"],
    viewerId: "u-app",
    onAssign: false,
    own: new LinearOwnComments(),
    bridge: null,
    turns: new LinearTurnQueue(),
    seen: new Set(),
    ...over,
  };
  return { ctx, posted, runTurn };
}

let seq = 0;
function created(over: Record<string, unknown> = {}): LinearWebhookPayload {
  return {
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: Date.now(),
    promptContext: "<issue identifier=\"ENG-7\"><title>Login breaks</title></issue>",
    agentSession: {
      id: `as-${++seq}`,
      issue: { id: "issue-7", identifier: "ENG-7", title: "Login breaks" },
      comment: { id: `c-${seq}`, body: "[@Atomic](https://linear.app/acme/profiles/atomic) please fix this" },
      creator: { id: OWNER, name: "Nadia" },
      ...over,
    },
  };
}

function prompted(sessionId: string, body: string, over: Record<string, unknown> = {}): LinearWebhookPayload {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    webhookTimestamp: Date.now(),
    agentSession: { id: sessionId, issue: { id: "issue-7", identifier: "ENG-7" }, creator: { id: OWNER } },
    agentActivity: { id: `act-${++seq}`, userId: OWNER, content: { type: "prompt", body }, ...over },
  };
}

describe("Linear agent sessions (ATO-2464)", () => {
  it("acknowledges with a thought first, then answers as a response activity in the session", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    const event = created();
    await handleLinearEvent(event, ctx);
    const sessionId = event.agentSession!.id!;
    expect(posted.map((p) => p.kind)).toEqual(["thought", "response"]);
    expect(posted[1]).toMatchObject({ body: "Fixed in the PR.", target: { agentSessionId: sessionId, issueId: "issue-7" } });
    const prompt = runTurn.mock.calls[0]![1];
    expect(prompt).toContain("[Linear agent session on ENG-7: Login breaks]");
    expect(prompt).toContain("<issue identifier=\"ENG-7\">");
  });

  it("refuses a session started by a non-owner with an error activity and runs nothing", async () => {
    const { ctx, posted, runTurn } = makeCtx();
    await handleLinearEvent(created({ creator: { id: "u-stranger" } }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted).toEqual([expect.objectContaining({ body: LINEAR_AGENT_NOT_OWNER, kind: "error" })]);
  });

  it("continues the issue's conversation on a follow-up prompt", async () => {
    const { ctx, runTurn } = makeCtx();
    const first = created();
    await handleLinearEvent(first, ctx);
    await handleLinearEvent(prompted(first.agentSession!.id!, "and add a test"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect((runTurn.mock.calls[0]![0] as { id: string }).id).toBe((runTurn.mock.calls[1]![0] as { id: string }).id);
    expect(runTurn.mock.calls[1]![1]).toContain("and add a test");
  });

  it("drops a follow-up from a non-owner, even in an owner's session", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleLinearEvent(prompted("as-x", "delete the repo", { userId: "u-stranger" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted[0]?.kind).toBe("error");
  });

  it("the Stop signal cancels the running turn", async () => {
    const { ctx, posted } = makeCtx();
    const controller = ctx.turns.add("issue-7");
    await handleLinearEvent(prompted("as-1", "", { signal: "stop" }), ctx);
    expect(controller.signal.aborted).toBe(true);
    expect(posted[0]).toMatchObject({ body: "Stopped.", kind: "response" });
  });

  it("a session's starting comment that also arrives as a Comment webhook runs once", async () => {
    const { ctx, runTurn } = makeCtx({ handles: ["atomic"] });
    const event = created();
    await handleLinearEvent(event, ctx);
    const comment = event.agentSession!.comment!;
    await handleLinearEvent(
      {
        type: "Comment",
        action: "create",
        actor: { id: OWNER },
        data: { id: comment.id, body: comment.body, issueId: "issue-7", userId: OWNER },
      },
      ctx,
    );
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("answers an approval code in a follow-up without a turn", async () => {
    const tryAnswer = vi.fn(() => "Approved.");
    const { ctx, runTurn, posted } = makeCtx({ bridge: { tryAnswer, pendingIn: () => 1 } });
    await handleLinearEvent(prompted("as-2", "yes K7Q2"), ctx);
    expect(tryAnswer).toHaveBeenCalledWith("issue-7", "yes K7Q2");
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ body: "Approved.", kind: "response" });
  });
});

describe("stripLeadingMention", () => {
  it.each([
    ["[@Atomic](https://linear.app/acme/profiles/atomic) /status", "/status"],
    ["@atomic, fix it", "fix it"],
    ["no mention here", "no mention here"],
  ])("%j -> %j", (input, out) => {
    expect(stripLeadingMention(input)).toBe(out);
  });
});
