import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySessionState, recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import type { ReflectionInput } from "../../memory/reflection/reflection-runner.js";
import type { AgentLoopEvent, AgentLoopReason, RunTurnOptions } from "../agent-contract.js";
import {
  finalizeAgentTurn,
  finalizeFailedAgentTurn,
  formatTaskStoppedReply,
  type TurnFinalizationContext,
  type TurnFinalizationDependencies,
} from "./turn-finalization.js";
import { MAX_SURFACED_NOTE_ALLOWLIST } from "./turn-memory-context.js";
import { captureModelModePolicy } from "../../llm/model-mode.js";

function context(reason: AgentLoopReason): TurnFinalizationContext {
  const options: RunTurnOptions = { maxSteps: 3, signal: new AbortController().signal, userMessage: "question" };
  let state = createEmptySessionState({ id: "end", workingDir: "/work" });
  state = recordTurn(state, userTurn("question"));
  state = recordTurn(state, assistantReplyTurn("answer"));
  return {
    state, options, reason, stepsTaken: 2, turnIndex: 0,
    turnStartedAt: 10, taskStartedAt: 10, stepCeiling: 3,
    stopCause: "step_ceiling", creditStop: null, endedOnFinalizationStep: false,
    surfacedLessonIds: new Set([7, 8]), surfacedProcedureIds: new Set([9]), surfacedNoteIds: new Set([4]),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("turn finalization seam", () => {
  it("reflects current state and live dependencies after turn_finished, before one steering drain", () => {
    const phases: string[] = [];
    const original = vi.fn(async () => {});
    const replacement = vi.fn(async (input: ReflectionInput) => { phases.push("reflect"); expect(input.userMessage).toBe("question\n\nsteered"); });
    const input = context("reply");
    input.state = recordTurn(createEmptySessionState({ id: "end", workingDir: "/work" }), userTurn("question"));
    input.state = recordTurn(input.state, userTurn("steered"));
    input.state = recordTurn(input.state, assistantReplyTurn("answer"));
    const deps: TurnFinalizationDependencies = {
      reflectionRunner: { reflect: original, abortPending() {} },
      onEvent(event) {
        phases.push(event.type);
        if (event.type === "turn_finished") {
          deps.reflectionRunner = { reflect: replacement, abortPending() {} };
          deps.reflectionSegmentation = { enabled: true, triggerEveryTurns: 1, windowTurns: 2 };
        }
      },
      lessonLifecycle: { recordTurnOutcome: () => phases.push("lesson") },
    };
    const result = finalizeAgentTurn(input, deps, (id) => { expect(id).toBe("end"); phases.push("drain"); return ["late"]; });
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["loop_completed", "turn_finished", "lesson", "reflect", "drain"]);
    expect(result.session.turnCount).toBe(1);
    expect(result.session.status).toBe("pending");
    expect(result.undelivered).toEqual(["late"]);
  });

  it("returns before background reflection settles and caps the union in insertion order", async () => {
    let settle: () => void = () => {};
    const reflect = vi.fn((input: ReflectionInput) => {
      expect(input.recalledMemoryIds).toEqual(Array.from({ length: MAX_SURFACED_NOTE_ALLOWLIST }, (_, i) => i + 4));
      expect(input.recalledLessonIds).toEqual([7, 8]);
      expect(input.recalledProcedureIds).toEqual([9]);
      return new Promise<void>((resolve) => { settle = resolve; });
    });
    const input = context("reply");
    input.surfacedNoteIds = new Set(Array.from({ length: 35 }, (_, i) => i + 1));
    input.options.modelModePolicy = captureModelModePolicy({ activeTextProvider: "test", activeEmbeddingProvider: "test", toolTransport: "auto", providers: [{ id: "test", kind: "openrouter", modelMode: "cloud" }] });
    const result = finalizeAgentTurn(input, { reflectionRunner: { reflect, abortPending() {} } }, () => []);
    expect(result.reason).toBe("reply");
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(reflect.mock.calls[0]![0].modelModePolicy).toBe(input.options.modelModePolicy);
    settle();
    await Promise.resolve();
  });

  it("reports background/store/hook failures while preserving successful terminal state", async () => {
    const logs: LogRecord[] = [];
    const logger = new StructuredLogger({ level: "warn", sinks: [(record) => logs.push(record)] });
    const result = finalizeAgentTurn(context("reply"), {
      logger,
      lessonLifecycle: { recordTurnOutcome() { throw new Error("lesson closed"); } },
      profileFactsProvider: () => { throw new Error("profile closed"); },
      reflectionRunner: { reflect: async () => { throw new Error("reflection closed"); }, abortPending() {} },
    }, () => []);
    await Promise.resolve();
    expect(result.session.status).toBe("pending");
    expect(logs.map((record) => record.message)).toEqual(["lesson lifecycle hook failed", "profile facts unavailable for reflection", "reflection failed after dispatch"]);
  });

  it.each(["cancelled", "max_steps"])("%s has no positive memory effects and increments turn count once", (reason) => {
    const input = context(reason === "cancelled" ? "cancelled" : "max_steps");
    const lesson = vi.fn();
    const reflect = vi.fn(async () => {});
    const events: AgentLoopEvent[] = [];
    const result = finalizeAgentTurn(input, { onEvent: (event) => events.push(event), lessonLifecycle: { recordTurnOutcome: lesson }, reflectionRunner: { reflect, abortPending() {} } }, () => []);
    expect(lesson).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
    expect(result.session.turnCount).toBe(1);
    expect(result.session.status).toBe(reason === "cancelled" ? "cancelled" : "stalled");
    expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);
    expect(result.stopCause).toBe(reason === "cancelled" ? undefined : "step_ceiling");
  });

  it("retains forced-final reply stopCause, skips ephemeral reflection/lessons, and preserves completed finish state", () => {
    const lesson = vi.fn();
    const reflect = vi.fn(async () => {});
    const deps: TurnFinalizationDependencies = { lessonLifecycle: { recordTurnOutcome: lesson }, reflectionRunner: { reflect, abortPending() {} } };
    const worker = context("reply");
    worker.options.ephemeral = true;
    worker.endedOnFinalizationStep = true;
    expect(finalizeAgentTurn(worker, deps, () => []).stopCause).toBe("step_ceiling");
    expect(lesson).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
    const finish = context("finish");
    finish.state = { ...finish.state, status: "completed" };
    const finished = finalizeAgentTurn(finish, {}, () => []);
    expect(finished.session.status).toBe("completed");
    expect(finished.stopCause).toBeUndefined();
  });

  it.each([
    { cancelled: true, creditRefused: false, ephemeral: false, hookCalls: 0, status: "cancelled" },
    { cancelled: false, creditRefused: true, ephemeral: false, hookCalls: 0, status: "failed" },
    { cancelled: false, creditRefused: false, ephemeral: true, hookCalls: 0, status: "failed" },
    { cancelled: false, creditRefused: false, ephemeral: false, hookCalls: 1, status: "failed" },
  ])("failed path $status credit=$creditRefused worker=$ephemeral keeps lesson meaning", ({ cancelled, creditRefused, ephemeral, hookCalls, status }) => {
    const input = context("failed");
    input.options.ephemeral = ephemeral;
    const lesson = vi.fn();
    const drain = vi.fn(() => ["pending"]);
    const result = finalizeFailedAgentTurn({ ...input, cancelled, creditRefused, category: "model", runError: new Error("empty") }, { lessonLifecycle: { recordTurnOutcome: lesson } }, drain);
    expect(result.session.status).toBe(status);
    expect(result.session.turnCount).toBe(1);
    expect(result.session.lastError).toBe(cancelled ? input.state.lastError : "empty");
    expect(result.stopCause).toBeUndefined();
    expect(lesson).toHaveBeenCalledTimes(hookCalls);
    if (hookCalls) expect(lesson).toHaveBeenCalledWith({ sessionId: "end", surfacedLessonIds: [7, 8], outcome: "failure" });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith("end");
  });

  it("keeps stopped reply formatting compatible with the facade", async () => {
    const facade = await import("../agent-loop.js");
    expect(facade.formatTaskStoppedReply).toBe(formatTaskStoppedReply);
    expect(facade.MAX_SURFACED_NOTE_ALLOWLIST).toBe(MAX_SURFACED_NOTE_ALLOWLIST);
  });
});
