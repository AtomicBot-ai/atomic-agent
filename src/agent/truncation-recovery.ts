import { ModelError } from "../llm/index.js";
import type { TruncationDetail } from "../llm/index.js";

/**
 * How the agent loop recovers from a reply the server cut short.
 *
 * A truncated completion is not a verdict on the step, but replaying the
 * same request is pointless — the same prompt under the same cap hits the
 * same wall. What helps depends on which wall it was
 * (`classifyTruncation`), and the two want opposite things:
 *
 *  - `reply_cap`: the model spent the whole `max_tokens` — typically a
 *    reasoning model thinking past the cap before it emits the tool
 *    call. The retry raises the cap for this one step.
 *  - `context_window`: the reply stopped short of the cap because the
 *    server ran out of context. Raising the cap cannot help; the retry
 *    reports the window the server just demonstrated so the next prompt
 *    is packed to fit, and runs under the same cap.
 *  - `output_limit`: the provider clamps this model's output below our
 *    cap. A bigger cap is refused or clamped again, a smaller prompt
 *    changes nothing — no retry; the message names the limit.
 *  - `unknown`: no usage came back. Treated as the cap — one wasted
 *    generation if it was the window, and the second cut ends the turn
 *    with a message that says so.
 *
 * One retry per step index. The model also reads a `### notice` saying
 * its reply was cut, so the retry is a different request in prompt as
 * well as in cap.
 */

/** Multiplier on the cap a truncated reply spent. */
export const TRUNCATION_RETRY_CAP_MULTIPLIER = 4;

/**
 * Ceiling on the raised cap. 32k covers a long think block plus a whole
 * file write; a reply that needs more is the problem, not the cap.
 */
export const TRUNCATION_RETRY_CAP_CEILING = 32_768;

/**
 * Headroom kept between a raised cap and a known window, for the drift
 * between our token estimate of the prompt and the server's count.
 */
const WINDOW_HEADROOM_TOKENS = 512;

export type TruncationRetry =
  | { kind: "raise_cap"; maxTokens: number }
  | { kind: "fit_window"; contextWindow: number };

export interface TruncationRetryPlan {
  detail: TruncationDetail;
  retry: TruncationRetry;
}

export interface PlanTruncationRetryInput {
  /** The failure the step threw. Anything but a truncated `ModelError` plans nothing. */
  error: unknown;
  /** The step was already retried once; a second cut ends the turn. */
  alreadyRetried: boolean;
  /** The window the runtime believes in, when it knows one. */
  contextWindow: number | null;
  /** The cap the step ran under when the error does not say. */
  fallbackMaxTokens: number;
  /** Whether a learned window has anywhere to go (`onContextWindowObserved` wired). */
  canFitWindow: boolean;
}

export function planTruncationRetry(
  input: PlanTruncationRetryInput,
): TruncationRetryPlan | null {
  const { error } = input;
  if (!(error instanceof ModelError) || error.reason !== "truncated")
    return null;
  const detail = error.truncation;
  if (detail === undefined || input.alreadyRetried) return null;
  if (detail.cause === "output_limit") return null;
  if (detail.cause === "context_window") {
    if (!input.canFitWindow) return null;
    const contextWindow = detail.promptTokens + detail.completionTokens;
    if (contextWindow <= 0) return null;
    return { detail, retry: { kind: "fit_window", contextWindow } };
  }
  const requested =
    detail.requestedMaxTokens > 0
      ? detail.requestedMaxTokens
      : input.fallbackMaxTokens;
  if (requested <= 0) return null;
  let raised = Math.min(
    TRUNCATION_RETRY_CAP_CEILING,
    requested * TRUNCATION_RETRY_CAP_MULTIPLIER,
  );
  // A cap the window cannot hold is a 400 waiting to happen on a strict
  // provider, and a silent clamp on llama.cpp. Stay under what is known.
  if (
    input.contextWindow !== null &&
    input.contextWindow > 0 &&
    detail.promptTokens > 0
  ) {
    raised = Math.min(
      raised,
      input.contextWindow - detail.promptTokens - WINDOW_HEADROOM_TOKENS,
    );
  }
  if (raised <= requested) return null;
  return { detail, retry: { kind: "raise_cap", maxTokens: raised } };
}

/**
 * The `### notice` the retried step carries. Imperative and short: the
 * step's transcript already shows nothing of the cut reply, so this is
 * the only place the model learns why it is being asked again.
 */
export function formatTruncationNotice(
  detail: TruncationDetail,
  retry: TruncationRetry,
): string {
  const cut =
    detail.completionTokens > 0
      ? `Your previous reply to this step was cut off after ${detail.completionTokens} tokens, before it finished.`
      : "Your previous reply to this step was cut off before it finished.";
  if (retry.kind === "raise_cap") {
    return (
      `${cut} The reply limit is ${retry.maxTokens} tokens for this attempt. ` +
      "Keep your reasoning brief and emit the tool call now; if the output is long, split it across several steps."
    );
  }
  return (
    `${cut} The model server ran out of context, so older conversation has been trimmed to fit. ` +
    "Continue from the latest tool results, keep your reasoning brief, and emit the tool call now."
  );
}

/**
 * Fold the truncation notice into whatever one-shot notice the step
 * already carries (loop detector, steering). Existing text first: it
 * describes what the model did, which is context for what to do now.
 */
export function composeTruncationNotice(
  existing: string | undefined,
  detail: TruncationDetail,
  retry: TruncationRetry,
): string {
  const block = formatTruncationNotice(detail, retry);
  if (existing === undefined || existing.length === 0) return block;
  return `${existing}\n\n${block}`;
}
