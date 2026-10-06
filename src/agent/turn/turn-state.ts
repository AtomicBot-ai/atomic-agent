import type { AgentLoopReason, TaskStopCause } from "../agent-contract.js";

/** One turn's mutable control and recovery state, shared by its orchestrator and recovery recipe. */
export interface TurnLoopState {
  reason: AgentLoopReason;
  stepsTaken: number;
  /**
   * Why the task stopped, when the step loop ran out rather than the
   * model finishing. Drives the closing message: "ran out of steps"
   * and "made no progress for a whole leg" are different things to
   * tell someone, and the old single `max_steps` string said neither.
   */
  stopCause: TaskStopCause;
  /** Set with `stopCause = "credit_exhausted"`: who refused, and what they said. */
  creditStop: { provider: string; detail: string } | null;
  /**
   * The duration ceiling fired inside a completion request (F15). The
   * next iteration is the finalization step whatever the clock says —
   * the request was abandoned, so the wall must not be re-argued.
   */
  ceilingFiredMidRequest: boolean;
  /**
   * The model's `reply` / `finish` came on the forced finalization
   * step, so a ceiling ended the task even though the model closed it.
   * Surfaced as `RunTurnResult.stopCause`.
   */
  endedOnFinalizationStep: boolean;
  /** Set by any step in the current leg that produced a usable result. */
  legMadeProgress: boolean;
  outageWaitedMs: number;
  outageAttempts: number;
  /** Retried a step after an outage and have not yet seen it succeed. */
  awaitingRecovery: boolean;
  // Truncation retry. A reply the server cut short is not a verdict on
  // the step either — but unlike an outage, replaying the same request
  // is pointless, so the retry changes it: a larger reply cap when the
  // cap was spent, a re-packed prompt when the window filled. One
  // retry per step index; the second cut ends the turn.
  truncationRetry: {
    stepIndex: number;
    maxTokens?: number;
    /** The truncation that started the retry, for the message if the retry is refused. */
    original: Error;
  } | null;
  /** The step index already retried after a request-size refusal. */
  sizeRepackRetry: { stepIndex: number } | null;
  /** The loop's own estimate of the last prompt built, for the repack fallback. */
  lastPromptTokens: number;
  /**
   * The step index whose leg boundary already ran. A retried step
   * (outage or truncation) re-enters the loop at the same index; the
   * boundary must not run twice, or its progress flag — reset by the
   * first pass — reads the retry as a whole leg with nothing to show.
   */
  lastBoundaryIndex: number;
  /**
   * Completions this turn that came back unparseable and were spent
   * another step on. Bounded by `PARSE_RECOVERY_BUDGET`: a model that
   * cannot emit a valid tool call twice in a row will not manage it on
   * the third try either, and the operator is owed the failure.
   */
  parseRecoveries: number;
  /**
   * Empty completions spent another step on, counted only while they
   * are CONSECUTIVE — any completion that carried something resets it
   * (see the reset next to `stepsTaken += 1` below). Bounded by
   * `EMPTY_COMPLETION_RECOVERY_BUDGET`, and separate from
   * `parseRecoveries` because the two shapes are different evidence:
   * an unparseable body is a model that tried, an empty one is a model
   * that emitted no tokens at all.
   */
  emptyRecoveries: number;
  // One-shot notice injected into the NEXT step's prompt only. Cleared
  // as soon as it is consumed so the stable tail does not carry stale
  // nudges across steps.
  pendingNotice: string | undefined;
}

export function createTurnLoopState(): TurnLoopState {
  return {
    reason: "max_steps",
    stepsTaken: 0,
    stopCause: "step_ceiling",
    creditStop: null,
    ceilingFiredMidRequest: false,
    endedOnFinalizationStep: false,
    legMadeProgress: false,
    outageWaitedMs: 0,
    outageAttempts: 0,
    awaitingRecovery: false,
    truncationRetry: null,
    sizeRepackRetry: null,
    lastPromptTokens: 0,
    lastBoundaryIndex: -1,
    parseRecoveries: 0,
    emptyRecoveries: 0,
    pendingNotice: undefined,
  };
}
