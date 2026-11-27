import { ModelError } from "../../llm/index.js";
import type { TurnLoopState } from "./turn-state.js";
import { TRUNCATION_RETRY_TURN_BUDGET } from "./truncation-recovery.js";

/**
 * The failure a step ends with when it was cut at its length limit again
 * after its truncation retry (ATO-1678).
 *
 * The retry (`planTruncationRetry`) already told the model its reply was
 * cut, where, and to think less or do the work in smaller pieces, the
 * way Claude Code answers a tool call cut at `max_tokens`. A second cut
 * after that is the model running into the limit whatever it is told,
 * so the turn says so in plain words ("kept writing past its reply
 * limit", or "got stuck repeating" when both cuts were a loop) instead
 * of "the reply was cut off, retry", which the agent itself just did.
 *
 * `null` when the step never got its retry: the first cut of a step, a
 * full context window (its own recovery and message), or anything that
 * is not a truncated `ModelError`.
 */
export function repeatedTruncationError(
  err: unknown,
  stepIndex: number,
  turn: Pick<TurnLoopState, "truncationRetry" | "truncationRetries">,
): ModelError | null {
  if (!(err instanceof ModelError) || err.reason !== "truncated") return null;
  if (err.repeatedCut !== undefined) return null;
  const detail = err.truncation;
  if (detail === undefined || detail.cause === "context_window") return null;
  const sameStep =
    turn.truncationRetry !== null &&
    turn.truncationRetry.stepIndex === stepIndex &&
    turn.truncationRetry.attempts > 0;
  if (!sameStep && turn.truncationRetries < TRUNCATION_RETRY_TURN_BUDGET) return null;
  // A loop only when the cut that started the retry looped too: the
  // notice named the loop and the model looped on.
  const original = sameStep ? turn.truncationRetry?.original : undefined;
  const looped =
    detail.repetitive === true &&
    original instanceof ModelError &&
    original.truncation?.repetitive === true;
  // The cut's own sentence first: it names the wall and the knob, and
  // logs and surfaces that read the failure keep their wording.
  const message = looped
    ? `${err.message}; the model looped again after it was told it was looping`
    : `${err.message}; cut again after the agent asked for smaller pieces`;
  return new ModelError("truncated", message, {
    cause: err,
    ...(err.transport !== undefined ? { transport: err.transport } : {}),
    ...(err.stage !== undefined ? { stage: err.stage } : {}),
    truncation: detail,
    ...(err.completion !== undefined ? { completion: err.completion } : {}),
    repeatedCut: looped ? "loop" : "cut",
  });
}
