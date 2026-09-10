import { parseCreditLimit } from "./parse-credit-limit.js";

/**
 * Fraction of the affordable ceiling left unspent on the retry.
 *
 * The number the service quotes is computed against a balance that is a
 * moment old: another request on the same key, a rounding difference in
 * how the two ends price the prompt, or a rate that ticked between the
 * refusal and the retry all make "exactly affordable" a coin flip. 5% is
 * enough headroom to make the second attempt land while costing the user
 * almost none of the ceiling they can actually afford.
 */
export const CREDIT_LIMIT_HEADROOM = 0.05;

/**
 * The smallest ceiling worth retrying with.
 *
 * Below roughly a thousand output tokens the agent cannot finish a useful
 * turn — a tool call plus its explanation does not fit — so a "successful"
 * retry would only replace a clear billing error with a truncated answer
 * the user has to diagnose. At that point the balance, not the ceiling,
 * is the problem, and the operator should read the provider's own message.
 */
export const CREDIT_LIMIT_MIN_MAX_TOKENS = 1024;

/** Minimal logging surface this recovery needs (satisfied by `StructuredLogger`). */
export interface CreditLimitLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface CreditLimitRetryPlan {
  /** The ceiling the refused request carried, as the service read it. */
  requestedMaxTokens: number;
  /** The ceiling the service said the balance covers. */
  affordableMaxTokens: number;
  /** The ceiling to retry with: the affordable one, minus headroom. */
  retryMaxTokens: number;
}

/**
 * Decide whether a failed request is a self-describing credit refusal
 * that can be recovered by asking for fewer output tokens.
 *
 * The case: an OpenAI-compatible service reserves the whole `max_tokens`
 * ceiling against the account balance up front, so a generous ceiling can
 * make *every* request fail with HTTP 402 on an account that has plenty of
 * credit for the turn actually being run. Nothing is down, nothing is
 * throttled, and no other provider in the fallback chain would do better —
 * the request just has to ask for less. Since the refusal names the number
 * that would work, the client can do that itself instead of making the
 * operator find and edit `localModels.completionMaxTokens`.
 *
 * Returns `null` — meaning "surface the provider's error untouched" —
 * unless *all* of these hold, because a wrong guess here costs a second
 * billable request and a delayed error message:
 *  - the status is exactly 402 (Payment Required); no other status is
 *    read as a credit problem,
 *  - `parseCreditLimit` recognised both counts in the body, and
 *  - the affordable ceiling clears {@link CREDIT_LIMIT_MIN_MAX_TOKENS}.
 *
 * Deliberately narrow: this is one targeted recovery for one specific
 * refusal, not a general retry policy. The bounded per-provider retry
 * budget and the cross-provider fallback chain are untouched, and neither
 * would help here anyway — a 402 is deterministic.
 */
export function planCreditLimitRetry(refusal: {
  status: number | null;
  message: string;
}): CreditLimitRetryPlan | null {
  if (refusal.status !== 402) return null;
  const limit = parseCreditLimit(refusal.message);
  if (!limit) return null;
  if (limit.affordable < CREDIT_LIMIT_MIN_MAX_TOKENS) return null;
  const retryMaxTokens = Math.max(
    CREDIT_LIMIT_MIN_MAX_TOKENS,
    Math.floor(limit.affordable * (1 - CREDIT_LIMIT_HEADROOM)),
  );
  return {
    requestedMaxTokens: limit.requested,
    affordableMaxTokens: limit.affordable,
    retryMaxTokens,
  };
}

/**
 * The warn line the retry emits.
 *
 * This recovery must never be silent. It costs a round-trip, it lowers the
 * output ceiling for that request, and its root cause is the operator's
 * balance — none of which is visible from the answer that comes back. The
 * wording names the balance as the constraint and both ceilings, so a log
 * reader can tell "I am being billed at my limit" apart from "the provider
 * is flaky" without correlating anything.
 */
export function creditLimitRetryMessage(
  providerId: string,
  plan: CreditLimitRetryPlan,
): string {
  return (
    `llm: "${providerId}" refused the request for lack of credit (402) — ` +
    `it reserves the full max_tokens ceiling against your balance, and can ` +
    `afford ${plan.affordableMaxTokens} of the ${plan.requestedMaxTokens} output ` +
    `tokens requested. Retrying once with max_tokens=${plan.retryMaxTokens}. ` +
    `Your balance is the constraint here, not the provider: top up the account, ` +
    `or lower localModels.completionMaxTokens to avoid the extra round-trip.`
  );
}

/** Structured fields for the same event, for log sinks that carry context. */
export function creditLimitRetryContext(
  providerId: string,
  plan: CreditLimitRetryPlan,
): Record<string, unknown> {
  return {
    provider: providerId,
    requestedMaxTokens: plan.requestedMaxTokens,
    affordableMaxTokens: plan.affordableMaxTokens,
    retryMaxTokens: plan.retryMaxTokens,
  };
}
