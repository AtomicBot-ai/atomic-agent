import { ModelError } from "../../llm/index.js";
import type { TruncationDetail } from "../../llm/index.js";

/**
 * How the agent loop recovers from a reply the server cut short.
 *
 * A truncated completion is not a verdict on the step, but replaying the
 * same request unchanged is pointless: the same prompt under the same
 * cap hits the same wall. Every retry carries a `### notice` saying the
 * reply was cut, so even a same-cap retry is a different request. What
 * else changes depends on the wall (`classifyTruncation`) and on the
 * model mode, `local` or `cloud` (decided 22.10, ATO-789):
 *
 *  - `context_window`: the server ran out of context. The retry reports
 *    the window the server just demonstrated so the next prompt is
 *    packed to fit, under the same cap. Once per step, either mode.
 *  - `output_limit` (and `provider_limit` on cloud): the provider cut
 *    the reply at its own limit. The retry runs capped at what it
 *    delivered (`same_cap`), and the notice asks for less.
 *  - `reply_cap` / `unknown` on cloud: the cap is the provider's, often
 *    already its maximum, so it stays (`same_cap`) and the notice says
 *    think less, write a large file in parts. Up to
 *    `TRUNCATION_RETRY_STEP_BUDGET` retries per step.
 *  - `reply_cap` / `unknown` / `provider_limit` on local: one retry per
 *    step. The cap goes up `TRUNCATION_RETRY_CAP_MULTIPLIER`-fold
 *    (`raise_cap`), unless the cut reply was a loop (`repetitive`): a
 *    bigger cap on a looping small model is minutes of more loop, so it
 *    stays. A cap already at the ceiling also stays.
 *
 * `TRUNCATION_RETRY_TURN_BUDGET` bounds the retries of back-to-back cut
 * steps, so a model that is cut on every step still ends the turn; a
 * step that completes without a cut resets it (`AgentLoop`), so a long
 * task with a cut here and there is never failed for its total.
 */

/** Multiplier on the cap a truncated local reply spent (raised once per step). */
export const TRUNCATION_RETRY_CAP_MULTIPLIER = 2;

/**
 * Ceiling on the raised cap. 32k covers a long think block plus a whole
 * file write; a reply that needs more is the problem, not the cap.
 */
export const TRUNCATION_RETRY_CAP_CEILING = 32_768;

/** Retries one step may take on a cloud model; a local step gets one. */
export const TRUNCATION_RETRY_STEP_BUDGET = 2;

/** Retries back-to-back cut steps may take before the next cut fails the turn. */
export const TRUNCATION_RETRY_TURN_BUDGET = 6;

/**
 * Headroom kept between a raised cap and a known window, for the drift
 * between our token estimate of the prompt and the server's count.
 */
const WINDOW_HEADROOM_TOKENS = 512;

export type TruncationRetry =
  | { kind: "raise_cap"; maxTokens: number }
  | { kind: "same_cap"; maxTokens: number }
  | { kind: "fit_window"; contextWindow: number };

export interface TruncationRetryPlan {
  detail: TruncationDetail;
  retry: TruncationRetry;
}

export interface PlanTruncationRetryInput {
  /** The failure the step threw. Anything but a truncated `ModelError` plans nothing. */
  error: unknown;
  /** Truncation retries this step index already took. */
  stepAttempts: number;
  /** Truncation retries taken since the last step that completed without a cut. */
  turnAttempts: number;
  /** The model mode serving the step; legacy wiring without one reads as `local`. */
  modelMode: "local" | "cloud";
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
  if (detail === undefined) return null;
  if (input.turnAttempts >= TRUNCATION_RETRY_TURN_BUDGET) return null;
  const cloud = input.modelMode === "cloud";
  const stepBudget = cloud ? TRUNCATION_RETRY_STEP_BUDGET : 1;
  if (input.stepAttempts >= stepBudget) return null;
  if (detail.cause === "context_window") {
    if (!input.canFitWindow || input.stepAttempts > 0) return null;
    const contextWindow = detail.promptTokens + detail.completionTokens;
    if (contextWindow <= 0) return null;
    return { detail, retry: { kind: "fit_window", contextWindow } };
  }
  const sent = detail.requestedMaxTokens ?? 0;
  const requested = sent > 0 ? sent : input.fallbackMaxTokens;
  if (
    detail.cause === "output_limit" ||
    (cloud && detail.cause === "provider_limit")
  ) {
    // The provider's own limit is what it just delivered.
    const limit =
      detail.completionTokens > 0 ? detail.completionTokens : requested;
    if (limit <= 0) return null;
    return { detail, retry: { kind: "same_cap", maxTokens: limit } };
  }
  if (requested <= 0) return null;
  if (cloud) {
    return { detail, retry: { kind: "same_cap", maxTokens: requested } };
  }
  // A cap the window cannot hold is a 400 waiting to happen on a strict
  // provider, and a silent clamp on llama.cpp. Stay under what is known.
  const room =
    input.contextWindow !== null &&
    input.contextWindow > 0 &&
    detail.promptTokens > 0
      ? input.contextWindow - detail.promptTokens - WINDOW_HEADROOM_TOKENS
      : Number.POSITIVE_INFINITY;
  const raised = Math.min(
    TRUNCATION_RETRY_CAP_CEILING,
    requested * TRUNCATION_RETRY_CAP_MULTIPLIER,
    room,
  );
  if (detail.repetitive !== true && raised > requested) {
    return { detail, retry: { kind: "raise_cap", maxTokens: raised } };
  }
  const kept = Math.min(requested, room);
  if (kept <= 0) return null;
  return { detail, retry: { kind: "same_cap", maxTokens: kept } };
}

/** The cap a retry sends, when it changes the cap at all. */
export function truncationRetryMaxTokens(
  retry: TruncationRetry,
): number | undefined {
  return retry.kind === "fit_window" ? undefined : retry.maxTokens;
}

/** Asked of every cap-bound retry: the way out of a long reply. */
const WRITE_IN_PARTS =
  'If you are writing a large file, write it in parts: create it with the first part, then add the rest with os.fs.write mode "append" in the next steps.';

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
      `Keep your reasoning brief and emit the tool call now. ${WRITE_IN_PARTS}`
    );
  }
  if (retry.kind === "same_cap") {
    const loop =
      detail.repetitive === true
        ? " It was repeating the same text over and over; do not repeat it."
        : "";
    return (
      `${cut}${loop} The reply limit stays at ${retry.maxTokens} tokens. ` +
      `Think less: keep your reasoning brief and emit the tool call now. ${WRITE_IN_PARTS}`
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
