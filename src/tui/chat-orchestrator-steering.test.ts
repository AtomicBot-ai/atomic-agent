import { describe, expect, it } from "vitest";

import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
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
