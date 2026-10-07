import { afterEach, describe, expect, it, vi } from "vitest";
import { CancelledError, GrammarError, LlamaServerError, ModelError, TransportError } from "../../llm/index.js";
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../../llm/provider/openai/parse-provider-error-body.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import type { AgentLoopEvent } from "../agent-contract.js";
import { abortableSleep, recoverTurnStep, type TurnRecoveryContext, type TurnRecoveryDependencies } from "./turn-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

function context(overrides: Partial<TurnRecoveryContext> = {}): TurnRecoveryContext {
  return {
    state: createEmptySessionState({ id: "recover", workingDir: "/work" }),
    options: { maxSteps: 4, signal: new AbortController().signal },
    stepIndex: 0,
    finalizationStep: false,
    noticeForThisStep: "existing notice",
    effectiveTransport: "native_tools",
    requestDeadline: { dispose() {}, fired: () => false },
    resumesStoppedTask: false,
    taskStartedAt: 0,
    durationCeilingMs: 1_000,
    providerWaitCfg: { enabled: false, maxWaitMs: 10 },
    recoveryStepAvailable: () => true,
    ...overrides,
  };
}
function truncated(): ModelError {
  return new ModelError("truncated", "reply hit its cap", {
    transport: "native_tools", stage: "initial",
    truncation: { cause: "reply_cap", completionTokens: 8_192, promptTokens: 6_000, requestedMaxTokens: 8_192 },
  });
}
function providerRefusal(status: number, body: string): TransportError {
  return new TransportError("provider refusal", status, "https://vendor/v1", {
    cause: new OpenAiHttpError(`openai provider ${status}: ${body}`, status, "https://vendor/v1", false, null, "vendor", undefined, { body: parseProviderErrorBody(body) }),
  });
}
const empty = () => new ModelError("empty", "empty completion", { transport: "native_tools", stage: "initial" });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("turn recovery decisions and shared state", () => {
  it("creates fresh literal-only state without clock reads or shared mutable retry references", () => {
    vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock read"); });
    const first = createTurnLoopState();
    const second = createTurnLoopState();
    first.truncationRetry = { stepIndex: 1, original: new Error("cut") };
    first.reason = "cancelled";
    expect(Object.keys(second)).toHaveLength(17);
    expect(second.truncationRetry).toBeNull();
    expect(second.reason).toBe("max_steps");
    expect(second.lastBoundaryIndex).toBe(-1);
  });

  it("disposes before deadline classification and requests a same-index summary instead of user cancellation", async () => {
    const phases: string[] = [];
    const turn = createTurnLoopState();
    const decision = recoverTurnStep(new CancelledError(), context({ requestDeadline: { dispose: () => phases.push("dispose"), fired: () => { phases.push("fired"); return true; } } }), { logger: new StructuredLogger({ level: "warn", sinks: [(record) => phases.push(record.message)] }) }, turn);
    expect(decision).toEqual({ kind: "retry_same" });
    expect(turn.stopCause).toBe("time_ceiling");
    expect(turn.ceilingFiredMidRequest).toBe(true);
    expect(turn.stepsTaken).toBe(0);
    expect(phases).toEqual(["dispose", "fired", "task time ceiling reached mid-request; running the summary step"]);
  });

  it("a summary deadline stops with max_steps and consumes one attempted step", async () => {
    const turn = createTurnLoopState();
    const result = recoverTurnStep(new CancelledError(), context({ finalizationStep: true, requestDeadline: { dispose() {}, fired: () => true } }), {}, turn);
    expect(result).toEqual({ kind: "stop" });
    expect(turn.reason).toBe("max_steps");
    expect(turn.stepsTaken).toBe(1);
  });

  it.each([
    new TransportError("terminated", null, "u"),
    new GrammarError("cut-off body", ""),
    empty(),
  ])("an aborted request %s bypasses finalization/retry with original error identity", async (error) => {
    const controller = new AbortController();
    controller.abort();
    const turn = createTurnLoopState();
    const events: AgentLoopEvent[] = [];
    const result = recoverTurnStep(error, context({ finalizationStep: true, options: { maxSteps: 4, signal: controller.signal } }), { onEvent: (event) => events.push(event) }, turn);
    expect(result).toEqual({ kind: "failure", cancelled: true, category: "cancelled", runError: error, creditRefused: false });
    expect(events).toEqual([{ type: "loop_failed", error, category: "cancelled" }]);
    expect(turn.stepsTaken).toBe(0);
    expect(turn.parseRecoveries).toBe(0);
    expect(turn.outageAttempts).toBe(0);
  });

  it("does not relabel an unclassified programming error as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error("bug");
    const result = recoverTurnStep(error, context({ options: { maxSteps: 4, signal: controller.signal } }), {}, createTurnLoopState());
    expect(result).toEqual({ kind: "failure", cancelled: false, category: "tool", runError: error, creditRefused: false });
  });

  it("a rejected parse spends a next step, resets empty streak before its event, and preserves the owed notice", async () => {
    const turn = createTurnLoopState();
    turn.emptyRecoveries = 1;
    const events: AgentLoopEvent[] = [];
    const result = recoverTurnStep(new GrammarError("malformed", "{bad}"), context(), { onEvent: (event) => { expect(turn.stepsTaken).toBe(1); expect(turn.emptyRecoveries).toBe(0); events.push(event); } }, turn);
    expect(result).toEqual({ kind: "retry_next" });
    expect(turn.parseRecoveries).toBe(1);
    expect(turn.pendingNotice).toContain("existing notice");
    expect(events).toEqual([{ type: "parse_failure_recovered", stepIndex: 0, attempt: 1, budget: 2, reason: "malformed" }]);
  });

  it("a blocked leg boundary does not announce or count an unavailable parse recovery", async () => {
    const turn = createTurnLoopState();
    const error = new GrammarError("malformed", "{bad}");
    const result = recoverTurnStep(error, context({ recoveryStepAvailable: () => false }), {}, turn);
    expect(result).toEqual({ kind: "failure", cancelled: false, category: "grammar", runError: error, creditRefused: false });
    expect(turn.parseRecoveries).toBe(0);
    expect(turn.stepsTaken).toBe(0);
  });

  it("a repeated announced empty still fails on the summary step instead of hiding its diagnosis", async () => {
    const turn = createTurnLoopState();
    expect(recoverTurnStep(empty(), context(), {}, turn)).toEqual({ kind: "retry_next" });
    const error = empty();
    const repeated = recoverTurnStep(error, context({ finalizationStep: true, stepIndex: 1 }), {}, turn);
    expect(repeated.kind).toBe("failure");
    if (repeated.kind !== "failure") throw new Error("expected failure");
    expect(repeated.runError).toBeInstanceOf(ModelError);
    expect(repeated.runError.cause).toBe(error);
    expect(repeated.runError.message).toContain("twice in a row");
    expect(repeated.category).toBe("model");
    expect(turn.stepsTaken).toBe(1);
  });

  it("truncation retries before the finalization guard and a raised-cap rejection returns the original cause", async () => {
    const turn = createTurnLoopState();
    const error = truncated();
    expect(recoverTurnStep(error, context({ finalizationStep: true }), {}, turn)).toEqual({ kind: "retry_same" });
    expect(turn.truncationRetry?.original).toBe(error);
    expect(turn.truncationRetry?.maxTokens).toBe(32_768);
    expect(turn.stepsTaken).toBe(0);
    const rejected = recoverTurnStep(providerRefusal(400, "max_tokens is too large: 32768"), context(), {}, turn);
    expect(rejected).toEqual({ kind: "failure", cancelled: false, category: "model", runError: error, creditRefused: false });
  });

  it("window learning happens before live event lookup, then a repeated size refusal fails unchanged", async () => {
    const turn = createTurnLoopState();
    turn.lastPromptTokens = 9_000;
    const phases: string[] = [];
    const error = providerRefusal(400, "maximum context length is 8192 tokens, requested 9000 tokens");
    const deps: TurnRecoveryDependencies = {
      contextWindow: () => { phases.push("window-read"); return null; },
      onEvent: () => phases.push("old-event"),
      onContextWindowObserved: (window) => { expect(window).toBe(8_192); phases.push("learn"); deps.onEvent = (event) => phases.push(event.type); },
    };
    expect(recoverTurnStep(error, context(), deps, turn)).toEqual({ kind: "retry_same" });
    expect(phases).toEqual(["window-read", "window-read", "learn", "prompt_repacked"]);
    expect(turn.sizeRepackRetry).toEqual({ stepIndex: 0 });
    const repeated = recoverTurnStep(error, context(), deps, turn);
    expect(repeated).toEqual({ kind: "failure", cancelled: false, category: "transport", runError: error, creditRefused: false });
  });

  it.each([false, true])("credit refusal pauses only an already progressing/resumed task (%s)", async (resumed) => {
    const turn = createTurnLoopState();
    const error = providerRefusal(402, '{"error":{"code":"insufficient_credits","message":"no credits left"}}');
    const result = recoverTurnStep(error, context({ resumesStoppedTask: resumed }), {}, turn);
    expect(turn.outageAttempts).toBe(0);
    if (resumed) {
      expect(result).toEqual({ kind: "stop" });
      expect(turn.stopCause).toBe("credit_exhausted");
      expect(turn.creditStop?.provider).toBe("vendor");
    } else expect(result).toEqual({ kind: "failure", cancelled: false, category: "transport", runError: error, creditRefused: true });
  });

  it("clamps the wait decision to its remaining budget without starting a timer", () => {
    vi.useFakeTimers();
    const turn = createTurnLoopState();
    const error = new TransportError("offline", null, "u");
    const events: AgentLoopEvent[] = [];
    const decision = recoverTurnStep(error, context({ providerWaitCfg: { enabled: true, maxWaitMs: 7 } }), { onEvent: (event) => events.push(event) }, turn);
    expect(decision).toEqual({ kind: "wait", nextRetryMs: 7 });
    expect(turn.awaitingRecovery).toBe(true);
    expect(turn.outageAttempts).toBe(1);
    expect(turn.outageWaitedMs).toBe(0);
    expect(turn.pendingNotice).toBeUndefined();
    expect(events[0]).toMatchObject({ type: "provider_waiting", waitedMs: 0, nextRetryMs: 7, maxWaitMs: 7 });
    expect(vi.getTimerCount()).toBe(0);
    turn.outageWaitedMs = 7;
    const failure = recoverTurnStep(error, context({ providerWaitCfg: { enabled: true, maxWaitMs: 7 } }), {}, turn);
    expect(failure.kind).toBe("failure");
    expect(turn.outageAttempts).toBe(1);
  });

  it("the original sleep helper resolves on abort and removes its pending timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = abortableSleep(20, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    const elapsed = abortableSleep(7, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(7);
    await elapsed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps summary failure and its caller footer ahead of a queued logger callback", async () => {
    const phases: string[] = [];
    const decision = recoverTurnStep(empty(), context({ finalizationStep: true }), {
      logger: new StructuredLogger({ level: "warn", sinks: [() => {
        phases.push("failure");
        queueMicrotask(() => phases.push("queued"));
      }] }),
    }, createTurnLoopState());
    expect(decision).toEqual({ kind: "stop" });
    phases.push("footer");
    expect(phases).toEqual(["failure", "footer"]);
    await Promise.resolve();
    expect(phases).toEqual(["failure", "footer", "queued"]);
  });

  it("a wrapped own llama deadline never enters provider parking", async () => {
    const error = new TransportError("timed out", null, "u", { cause: new LlamaServerError("deadline", null, "u", true) });
    const turn = createTurnLoopState();
    const logs: LogRecord[] = [];
    const result = recoverTurnStep(error, context({ providerWaitCfg: { enabled: true, maxWaitMs: 10 } }), { logger: new StructuredLogger({ level: "warn", sinks: [(record) => logs.push(record)] }) }, turn);
    expect(result.kind).toBe("failure");
    expect(turn.outageAttempts).toBe(0);
    expect(logs.map((record) => record.message)).toEqual(["agent loop failed"]);
  });
});
