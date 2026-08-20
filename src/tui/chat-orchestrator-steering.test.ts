import { describe, expect, it } from "vitest";

import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { SteeringInbox } from "../runtime/steering-inbox.js";
import { TurnController } from "../runtime/turn-controller.js";
import type { RunTurnResult } from "../agent/agent-loop.js";
import {
  createEmptySessionState,
  type SessionState,
} from "../session/session-state.js";
import type { TuiAction } from "./tui-action.js";

/**
 * The TUI's half of the mid-turn steering contract (AGENTS.md
 * §"Mid-turn steering"):
 *   - a message typed while a turn is running is offered to that turn
 *     first, and only falls back to the orchestrator's own pending
 *     queue when `steer` refuses it;
 *   - `RunTurnResult.undelivered` — messages the turn accepted but
 *     never delivered — is re-routed onto that same queue. `steer`
 *     already told the sender "yes"; dropping it here would lose a
 *     message the operator watched being accepted.
 */

interface Harness {
  chat: ChatOrchestrator;
  actions: TuiAction[];
  /** Messages handed to `runtime.runTurn`, in order. */
  started: string[];
  /** Resolve the turn currently in flight. */
  finish(result?: Partial<RunTurnResult>): Promise<void>;
  steerCalls: Array<{ sessionId: string; text: string }>;
  setSteerable(value: boolean): void;
}

function makeHarness(): Harness {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((action) => actions.push(action));

  const started: string[] = [];
  const steerCalls: Array<{ sessionId: string; text: string }> = [];
  let steerable = true;
  let session: SessionState = createEmptySessionState({
    id: "s-tui",
    workingDir: "/work",
  });
  let settle: ((result: RunTurnResult) => void) | null = null;

  const runtime = {
    createSession: () => session,
    sessionStore: {
      listRecent: () => [],
      load: () => session,
    },
    approvals: { clearSessionGrants: () => undefined },
    steer: (sessionId: string, text: string) => {
      steerCalls.push({ sessionId, text });
      return steerable;
    },
    runTurn: (_session: SessionState, text: string) => {
      started.push(text);
      return new Promise<RunTurnResult>((resolve) => {
        settle = resolve;
      });
    },
  } as unknown as AgentRuntime;

  const chat = new ChatOrchestrator(runtime, bus, {
    maxSteps: 4,
    llamaUrl: "http://127.0.0.1:8080",
  });

  return {
    chat,
    actions,
    started,
    steerCalls,
    setSteerable: (value) => {
      steerable = value;
    },
    finish: async (result = {}) => {
      const resolve = settle;
      settle = null;
      if (!resolve) throw new Error("no turn in flight");
      resolve({
        session,
        reason: "reply",
        stepCount: 1,
        ...result,
      });
      // Two microtask hops: one for `await runtime.runTurn`, one for the
      // queue drain that follows it.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function infoLines(actions: readonly TuiAction[]): string[] {
  return actions
    .filter((a): a is Extract<TuiAction, { type: "runtime_info" }> =>
      a.type === "runtime_info",
    )
    .map((a) => a.line);
}

describe("ChatOrchestrator mid-turn steering", () => {
  it("offers a message typed during a turn to that turn", async () => {
    const h = makeHarness();
    h.chat.sendMessage("do the thing");
    h.chat.sendMessage("actually, check the logs first");

    expect(h.steerCalls).toEqual([
      { sessionId: "s-tui", text: "actually, check the logs first" },
    ]);
    // Steered, so it must NOT also become a queued follow-up turn.
    await h.finish();
    expect(h.started).toEqual(["do the thing"]);
    expect(infoLines(h.actions)).toContain(
      "steering the running turn — the agent reads it at the next step",
    );
  });

  it("falls back to the pending queue when the turn refuses the steer", async () => {
    const h = makeHarness();
    h.chat.sendMessage("do the thing");
    h.setSteerable(false);
    h.chat.sendMessage("too late for this one");

    expect(h.steerCalls).toHaveLength(1);
    await h.finish();
    // Refused, so it runs as the next turn instead of vanishing.
    expect(h.started).toEqual(["do the thing", "too late for this one"]);
  });

  it("re-routes undelivered steers onto the pending queue", async () => {
    const h = makeHarness();
    h.chat.sendMessage("do the thing");
    // `steer` said yes, but the turn ended before a step could drain it.
    await h.finish({ undelivered: ["stop, use staging"] });

    expect(h.started).toEqual(["do the thing", "stop, use staging"]);
    expect(infoLines(h.actions)).toContain(
      "1 message arrived too late for that turn — sending it next",
    );
  });

  it("puts undelivered steers ahead of messages typed after the refusal", async () => {
    const h = makeHarness();
    h.chat.sendMessage("do the thing");
    h.setSteerable(false);
    h.chat.sendMessage("and then deploy");
    await h.finish({ undelivered: ["stop, use staging"] });

    // "stop, use staging" was sent first (it was still accepted as a
    // steer); "and then deploy" only arrived after `steer` refused.
    expect(h.started).toEqual(["do the thing", "stop, use staging"]);
    await h.finish();
    expect(h.started).toEqual([
      "do the thing",
      "stop, use staging",
      "and then deploy",
    ]);
  });

  it("does nothing extra on an ordinary turn", async () => {
    const h = makeHarness();
    h.chat.sendMessage("do the thing");
    await h.finish({ undelivered: [] });
    expect(h.started).toEqual(["do the thing"]);
    expect(infoLines(h.actions)).toEqual([]);
  });
});

/**
 * The span between "the orchestrator considers a turn in flight" and
 * "the loop opened the steering window for it".
 *
 * `runOneTurn` sets `currentController` and *then* awaits
 * `runtime.runTurn`; `AgentLoop.runTurn` opens the window only once the
 * submission owns the per-session lock — after `turnController.enqueue`
 * has parked in `waitOrAbort` behind whatever is still settling on that
 * session. A message submitted in that span sees a turn in flight and a
 * shut window, so `steer` refuses it. It is still a correction aimed at
 * the turn the operator is watching, so it must not be demoted behind
 * backlog, and the operator must still be told it was taken as one.
 *
 * The harness runs the real `TurnController` and the real
 * `SteeringInbox`; only the loop body is stubbed, in the shape
 * `AgentLoop.runTurn` actually has (`open` on entry, `closeAndDrain` on
 * the way out, and a settle phase after it for the session save plus the
 * controller's own `finally`). Gates, not sleeps.
 */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the microtask queue; every gate in this harness is a promise. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

interface GapHarness {
  chat: ChatOrchestrator;
  actions: TuiAction[];
  inbox: SteeringInbox;
  /** Turn bodies that actually started, in order. */
  started: string[];
  /** Occupy the session lock from another entry point (scheduler/HTTP). */
  occupy(text: string): Promise<RunTurnResult>;
  /** Let the turn running `text` reach its final drain (window shuts). */
  drain(text: string): Promise<void>;
  /** Let that turn's promise settle, releasing the per-session lock. */
  settle(text: string): Promise<void>;
}

const GAP_SESSION = "s-gap";

function makeGapHarness(): GapHarness {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((action) => actions.push(action));

  const session = createEmptySessionState({
    id: GAP_SESSION,
    workingDir: "/work",
  });
  const inbox = new SteeringInbox();
  const controller = new TurnController();
  const started: string[] = [];
  const gates = new Map<string, { drain: Deferred; settle: Deferred }>();
  const gateFor = (text: string): { drain: Deferred; settle: Deferred } => {
    const existing = gates.get(text);
    if (existing) return existing;
    const fresh = { drain: deferred(), settle: deferred() };
    gates.set(text, fresh);
    return fresh;
  };

  const turnBody = async (text: string): Promise<RunTurnResult> => {
    // `AgentLoop.runTurn`, in miniature.
    inbox.open(session.id);
    started.push(text);
    await gateFor(text).drain.promise;
    const undelivered = inbox.closeAndDrain(session.id);
    // The window is shut but the submission still owns the lock — this
    // is `sessionStore.save` plus the controller's `finally`, and it is
    // where the next submission is parked in `waitOrAbort`.
    await gateFor(text).settle.promise;
    return { session, reason: "reply", stepCount: 1, undelivered };
  };

  const runtime = {
    createSession: () => session,
    sessionStore: { listRecent: () => [], load: () => session },
    approvals: { clearSessionGrants: () => undefined },
    steer: (sessionId: string, text: string) => inbox.push(sessionId, text),
    runTurn: (
      _session: SessionState,
      text: string,
      options: { signal?: AbortSignal } = {},
    ) =>
      controller.enqueue({
        sessionId: session.id,
        origin: "tui" as const,
        run: () => turnBody(text),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
  } as unknown as AgentRuntime;

  const chat = new ChatOrchestrator(runtime, bus, {
    maxSteps: 4,
    llamaUrl: "http://127.0.0.1:8080",
  });

  return {
    chat,
    actions,
    inbox,
    started,
    occupy: (text) =>
      controller.enqueue({
        sessionId: session.id,
        origin: "scheduler",
        run: () => turnBody(text),
      }),
    drain: async (text) => {
      gateFor(text).drain.resolve();
      await flush();
    },
    settle: async (text) => {
      gateFor(text).settle.resolve();
      await flush();
    },
  };
}

describe("ChatOrchestrator steering into the commit-to-open gap", () => {
  it("acknowledges a steer sent while the turn is parked behind another one", async () => {
    const h = makeGapHarness();
    // An out-of-band turn (scheduler here, HTTP in production) owns the
    // session lock.
    const occupant = h.occupy("scheduled digest");
    await flush();
    expect(h.started).toEqual(["scheduled digest"]);

    // The TUI commits to a turn: `currentController` is set, but the
    // submission is parked in `waitOrAbort` and its loop never ran.
    h.chat.sendMessage("do the thing");
    await flush();
    expect(h.started).toEqual(["scheduled digest"]);

    // The occupant does its final drain. Now nothing on this session is
    // accepting steers, and nothing will until the parked turn starts.
    await h.drain("scheduled digest");
    expect(h.inbox.isOpen(GAP_SESSION)).toBe(false);

    h.chat.sendMessage("actually, check the logs first");
    // Half the defect is the silence: the operator aimed this at a turn
    // the TUI shows as running and used to get told so.
    expect(infoLines(h.actions)).toContain(
      "steering the running turn — it cannot take this one, so it runs as the next turn",
    );

    await h.settle("scheduled digest");
    await occupant;
    expect(h.started).toEqual(["scheduled digest", "do the thing"]);

    await h.drain("do the thing");
    await h.settle("do the thing");
    expect(h.started).toEqual([
      "scheduled digest",
      "do the thing",
      "actually, check the logs first",
    ]);
  });

  it("runs a steer sent in that gap before backlog left by an earlier turn", async () => {
    const h = makeGapHarness();
    h.chat.sendMessage("do the thing");
    await flush();
    expect(h.started).toEqual(["do the thing"]);

    // Turn 1's window shuts; its promise has not settled, so the TUI
    // still shows a turn in flight.
    await h.drain("do the thing");
    h.chat.sendMessage("backlog one");
    h.chat.sendMessage("backlog two");
    await h.settle("do the thing");
    // Re-routed in the order they were typed, not reversed.
    expect(h.started).toEqual(["do the thing", "backlog one"]);

    // Same gap, one turn later. "stop, use staging" is a correction to
    // the turn in flight; "backlog two" was aimed at the turn before it.
    await h.drain("backlog one");
    h.chat.sendMessage("stop, use staging");
    await h.settle("backlog one");
    expect(h.started).toEqual([
      "do the thing",
      "backlog one",
      "stop, use staging",
    ]);

    await h.drain("stop, use staging");
    await h.settle("stop, use staging");
    expect(h.started).toEqual([
      "do the thing",
      "backlog one",
      "stop, use staging",
      "backlog two",
    ]);
  });

  it("keeps undelivered steers ahead of ones re-routed after the window shut", async () => {
    const h = makeGapHarness();
    h.chat.sendMessage("do the thing");
    await flush();

    // Accepted while the window was open, but no step boundary came:
    // the turn hands it back on `undelivered`.
    expect(h.inbox.isOpen(GAP_SESSION)).toBe(true);
    h.chat.sendMessage("wait, staging");
    expect(h.inbox.peek(GAP_SESSION)).toEqual(["wait, staging"]);

    await h.drain("do the thing");
    // Typed after the window shut, i.e. after "wait, staging".
    h.chat.sendMessage("and read the logs");
    await h.settle("do the thing");

    expect(h.started).toEqual(["do the thing", "wait, staging"]);
    await h.drain("wait, staging");
    await h.settle("wait, staging");
    expect(h.started).toEqual([
      "do the thing",
      "wait, staging",
      "and read the logs",
    ]);
  });
});
