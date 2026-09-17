import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  readProviderErrorReason,
  RETRY_HINT_MAX_MS,
} from "../provider/openai/parse-provider-error-body.js";

/**
 * What a thrown provider failure means for the turn, read from the
 * error body rather than the status:
 *
 *  - `credit_exhausted`: the account cannot pay. No retry, no fallover
 *    wait — the turn stops where it is, resumable after a top-up, and
 *    the operator is told which provider said so.
 *  - `retry_after`: the provider asked for a cooldown (a `retry-after`
 *    header, `RetryInfo`, "retry in 120 s" in the text, or OpenRouter's
 *    `in_flight_budget_exhausted`). The turn waits that long — clipped
 *    to `RETRY_HINT_MAX_MS` — and retries the same step.
 *
 * A plain 429 or 5xx with neither reads as `null` and keeps the
 * existing outage park.
 */
export type ProviderErrorVerdict =
  | {
      kind: "credit_exhausted";
      /** Provider label as the user configured it (or the host). */
      provider: string;
      code: string;
      detail: string;
    }
  | {
      kind: "retry_after";
      provider: string;
      /** Already clipped to `RETRY_HINT_MAX_MS`. */
      delayMs: number;
      code: string | null;
      detail: string;
    };

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

export function readProviderErrorVerdict(
  err: unknown,
): ProviderErrorVerdict | null {
  const http = findHttpError(err);
  if (http === null) return null;
  const reason = readProviderErrorReason({
    status: http.status,
    body: http.body,
    message: http.message,
    retryAfterMs: http.retryAfterMs,
  });
  if (reason === null) return null;
  const provider = http.providerLabel || hostOf(http.url);
  const detail = http.body?.message ?? http.message;
  if (reason.kind === "credit_exhausted") {
    return { kind: "credit_exhausted", provider, code: reason.code, detail };
  }
  return {
    kind: "retry_after",
    provider,
    delayMs: Math.min(reason.delayMs ?? RETRY_HINT_MAX_MS, RETRY_HINT_MAX_MS),
    code: reason.code,
    detail,
  };
}

/**
 * The cloud HTTP error behind whatever wrapper reached the loop: the
 * step executor wraps it in a `TransportError` with the original on
 * `cause`, and the fallback chain rethrows the last link's error as is.
 */
function findHttpError(err: unknown): OpenAiHttpError | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof OpenAiHttpError) return current;
    if (typeof current !== "object" || current === null) return null;
    const next = (current as { cause?: unknown }).cause;
    if (next === current || next === undefined) return null;
    current = next;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
