import { describe, expect, it, vi } from "vitest";
import { createEmptySessionState, recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import type { AgentLoopReason, RunTurnOptions } from "../agent-contract.js";
import {
  finalizeAgentTurn,
  finalizeFailedAgentTurn,
  type TurnFinalizationContext,
  type TurnFinalizationDependencies,
} from "./turn-finalization.js";

/** ATO-586: an incognito chat writes nothing to memory at a turn's end. */
const MARK = { since: 1, owner: JSON.stringify({ pid: 1, at: 1 }) };

function context(reason: AgentLoopReason, incognito: boolean): TurnFinalizationContext {
  const options: RunTurnOptions = { maxSteps: 3, signal: new AbortController().signal, userMessage: "my name is Kai" };
  let state = createEmptySessionState({
    id: "chat",
    workingDir: "/work",
    ...(incognito ? { incognito: MARK } : {}),
  });
  state = recordTurn(state, userTurn("my name is Kai"));
  state = recordTurn(state, assistantReplyTurn("hi Kai"));
  return {
    state, options, reason, stepsTaken: 1, turnIndex: 0,
    turnStartedAt: 10, taskStartedAt: 10, stepCeiling: 3,
    stopCause: "step_ceiling", creditStop: null, endedOnFinalizationStep: false,
    surfacedLessonIds: new Set([7]), surfacedProcedureIds: new Set(), surfacedNoteIds: new Set([4]),
  };
}

function deps(): { deps: TurnFinalizationDependencies; reflect: ReturnType<typeof vi.fn>; lesson: ReturnType<typeof vi.fn> } {
  const reflect = vi.fn(async () => {});
  const lesson = vi.fn();
  return {
    reflect,
    lesson,
    deps: {
      reflectionRunner: { reflect, abortPending() {} },
      lessonLifecycle: { recordTurnOutcome: lesson },
      profileFactsProvider: () => [],
    },
  };
}

describe("turn finalization in an incognito chat", () => {
  it.each(["reply", "finish"] as const)("a %s neither reflects nor bumps lesson counters", (reason) => {
    const { deps: d, reflect, lesson } = deps();
    const result = finalizeAgentTurn(context(reason, true), d, () => []);
    expect(reflect).not.toHaveBeenCalled();
    expect(lesson).not.toHaveBeenCalled();
    // The turn itself closes as usual and keeps its mark.
    expect(result.session.turnCount).toBe(1);
    expect(result.session.incognito).toEqual(MARK);
  });

  it("the same reply in an ordinary chat still reflects and bumps lessons", () => {
    const { deps: d, reflect, lesson } = deps();
    finalizeAgentTurn(context("reply", false), d, () => []);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(lesson).toHaveBeenCalledWith({ sessionId: "chat", surfacedLessonIds: [7], outcome: "success" });
  });

  it("a failed turn records no lesson failure", () => {
    const { deps: d, lesson } = deps();
    finalizeFailedAgentTurn(
      { ...context("reply", true), cancelled: false, creditRefused: false, category: "model", runError: new Error("boom") },
      d,
      () => [],
    );
    expect(lesson).not.toHaveBeenCalled();
    const ordinary = deps();
    finalizeFailedAgentTurn(
      { ...context("reply", false), cancelled: false, creditRefused: false, category: "model", runError: new Error("boom") },
      ordinary.deps,
      () => [],
    );
    expect(ordinary.lesson).toHaveBeenCalledTimes(1);
  });
});
