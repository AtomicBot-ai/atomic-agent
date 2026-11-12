import { describe, expect, it } from "vitest";
import { CancelledError, TransportError } from "../../llm/index.js";
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { AgentLoopEvent } from "../agent-contract.js";
import { MID_REPLY_TIMEOUT_MIN_ELAPSED_MS, composeMidReplyTimeoutNotice } from "./mid-reply-timeout-recovery.js";
import { recoverTurnStep, type TurnRecoveryContext } from "./turn-recovery.js";
import { createTurnLoopState } from "./turn-state.js";

const URL = "https://vendor/v1/chat/completions";
const LONG = MID_REPLY_TIMEOUT_MIN_ELAPSED_MS;

function context(overrides: Partial<TurnRecoveryContext> = {}): TurnRecoveryContext {
  return {
    state: createEmptySessionState({ id: "mid-reply", workingDir: "/work" }),
    options: { maxSteps: 4, signal: new AbortController().signal },
    stepIndex: 2,
    finalizationStep: false,
    noticeForThisStep: undefined,
    effectiveTransport: "native_tools",
    requestDeadline: { dispose() {}, fired: () => false },
    resumesStoppedTask: false,
    taskStartedAt: 0,
    durationCeilingMs: 10_000_000,
    providerWaitCfg: { enabled: true, maxWaitMs: 300_000 },
    recoveryStepAvailable: () => true,
    requestElapsedMs: LONG,
    ...overrides,
  };
}

function midReply(status: number, message: string): TransportError {
  return new TransportError(`"openrouter" reported an error in the middle of its reply (${status}): ${message}`, status, URL, {
    cause: new OpenAiHttpError(`openai provider ${status}: ${message}`, status, URL, false, null, "openrouter", undefined, { streamError: message }),
  });
}
const timedOut = () => midReply(504, "A Timeout Occurred");

describe("recovery from a provider time limit that ends a long reply", () => {
  it("retries with a notice to work in smaller pieces instead of waiting", () => {
    const turn = createTurnLoopState();
    const events: AgentLoopEvent[] = [];
    const decision = recoverTurnStep(timedOut(), context({ noticeForThisStep: "earlier notice" }), { onEvent: (event) => events.push(event) }, turn);
    expect(decision).toEqual({ kind: "retry_same" });
    expect(turn.pendingNotice).toContain("earlier notice");
    expect(turn.pendingNotice).toContain("write it in parts");
    expect(turn.midReplyTimeoutRetry).toEqual({ stepIndex: 2, attempts: 1 });
    expect(turn.awaitingRecovery).toBe(false);
    expect(turn.outageAttempts).toBe(0);
    expect(events).toEqual([expect.objectContaining({ type: "reply_time_limit_retried", stepIndex: 2, attempt: 1, budget: 2 })]);
  });

  it("closes an earlier outage wait before retrying", () => {
    const turn = createTurnLoopState();
    turn.awaitingRecovery = true;
    turn.outageWaitedMs = 2_000;
    turn.outageAttempts = 1;
    const events: AgentLoopEvent[] = [];
    recoverTurnStep(timedOut(), context(), { onEvent: (event) => events.push(event) }, turn);
    expect(events.map((event) => event.type)).toEqual(["provider_recovered", "reply_time_limit_retried"]);
    expect(events[0]).toMatchObject({ waitedMs: 2_000 });
    expect(turn.awaitingRecovery).toBe(false);
    expect(turn.outageWaitedMs).toBe(0);
    expect(turn.outageAttempts).toBe(0);
  });

  it("does not stack the notice on the second retry", () => {
    const turn = createTurnLoopState();
    recoverTurnStep(timedOut(), context(), {}, turn);
    const carried = turn.pendingNotice;
    const decision = recoverTurnStep(timedOut(), context({ noticeForThisStep: carried }), {}, turn);
    expect(decision).toEqual({ kind: "retry_same" });
    expect(turn.pendingNotice).toBe(carried);
    expect(turn.midReplyTimeoutRetry?.attempts).toBe(2);
  });

  it("ends the turn on the third timeout of one step and says why", () => {
    const turn = createTurnLoopState();
    recoverTurnStep(timedOut(), context(), {}, turn);
    recoverTurnStep(timedOut(), context(), {}, turn);
    const decision = recoverTurnStep(timedOut(), context(), {}, turn);
    expect(decision).toMatchObject({ kind: "failure", category: "transport", cancelled: false });
    if (decision.kind !== "failure") throw new Error("expected a failure");
    expect(decision.runError.message).toContain('"openrouter"');
    expect(decision.runError.message).toContain("3 times");
  });

  it("gives a later step its own budget", () => {
    const turn = createTurnLoopState();
    recoverTurnStep(timedOut(), context(), {}, turn);
    recoverTurnStep(timedOut(), context(), {}, turn);
    expect(recoverTurnStep(timedOut(), context({ stepIndex: 3 }), {}, turn)).toEqual({ kind: "retry_same" });
    expect(turn.midReplyTimeoutRetry).toEqual({ stepIndex: 3, attempts: 1 });
  });

  it("keeps a request exactly at the threshold and leaves a shorter one to the outage wait", () => {
    expect(recoverTurnStep(timedOut(), context({ requestElapsedMs: LONG }), {}, createTurnLoopState())).toEqual({ kind: "retry_same" });
    const turn = createTurnLoopState();
    expect(recoverTurnStep(timedOut(), context({ requestElapsedMs: LONG - 1 }), {}, turn).kind).toBe("wait");
    expect(turn.pendingNotice).toBeUndefined();
    expect(turn.midReplyTimeoutRetry).toBeNull();
  });

  it("leaves an unmeasured request to the outage wait", () => {
    expect(recoverTurnStep(timedOut(), context({ requestElapsedMs: undefined }), {}, createTurnLoopState()).kind).toBe("wait");
  });

  it("leaves other long failures to the outage wait", () => {
    expect(recoverTurnStep(midReply(502, "Network connection lost"), context(), {}, createTurnLoopState()).kind).toBe("wait");
    const onOpen = new TransportError("gateway timeout", 504, URL);
    expect(recoverTurnStep(onOpen, context(), {}, createTurnLoopState()).kind).toBe("wait");
  });

  it("keeps the failure when provider waiting is off", () => {
    const turn = createTurnLoopState();
    const decision = recoverTurnStep(timedOut(), context({ providerWaitCfg: { enabled: false, maxWaitMs: 300_000 } }), {}, turn);
    expect(decision.kind).toBe("failure");
    expect(turn.midReplyTimeoutRetry).toBeNull();
  });

  it("does not spend a retry on a stopped turn or the summary step", () => {
    const controller = new AbortController();
    controller.abort();
    const stopped = createTurnLoopState();
    expect(recoverTurnStep(timedOut(), context({ options: { maxSteps: 4, signal: controller.signal } }), {}, stopped)).toMatchObject({ kind: "failure", cancelled: true });
    expect(stopped.midReplyTimeoutRetry).toBeNull();
    expect(recoverTurnStep(new CancelledError(), context(), {}, createTurnLoopState())).toMatchObject({ cancelled: true });
    const summary = createTurnLoopState();
    expect(recoverTurnStep(timedOut(), context({ finalizationStep: true }), {}, summary).kind).toBe("stop");
    expect(summary.midReplyTimeoutRetry).toBeNull();
  });

  it("composes onto an empty notice", () => {
    expect(composeMidReplyTimeoutNotice("")).toBe(composeMidReplyTimeoutNotice(undefined));
  });
});
