/**
 * Retry scheduling for rate-limited (HTTP 429) search responses.
 *
 * The keyless tiers every default provider rides on (Exa's MCP endpoint,
 * DuckDuckGo's HTML endpoint) answer 429 under sustained agent load. Before
 * this module a single 429 threw straight out of the provider and the
 * orchestrator advanced the chain, which permanently downgraded a
 * search-heavy session to the weakest provider on the first transient limit.
 * Retrying the primary a couple of times first keeps the configured provider
 * in play; the fallback chain remains the backstop when the limit is real.
 */

/** Ceiling on a server-advertised `Retry-After`, so one hostile header cannot stall a turn. */
export const MAX_RETRY_AFTER_MS = 10_000;

export interface SearchRetryPolicy {
  /** Extra attempts after the initial request. `0` disables retrying. */
  maxRetries: number;
  /** Delay for the first retry; each subsequent retry doubles it. */
  baseDelayMs: number;
}

export const DEFAULT_SEARCH_RETRY_POLICY: SearchRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
};

/**
 * Parse a `Retry-After` header value. Supports both documented forms:
 * delta-seconds (`120`) and an HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`).
 * Returns `null` when absent or unparseable so the caller falls back to its
 * own backoff schedule. The result is clamped to `[0, MAX_RETRY_AFTER_MS]`.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: number,
): number | null {
  if (typeof headerValue !== "string") return null;
  const raw = headerValue.trim();
  if (raw.length === 0) return null;

  // delta-seconds. Guard against `Number.parseInt` accepting "10abc".
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isFinite(seconds)) return null;
    return clampDelay(seconds * 1000);
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return clampDelay(at - now);
}

/**
 * Delay before retry number `attempt` (1-based): the server's `Retry-After`
 * when it gave one, otherwise exponential backoff from `baseDelayMs`.
 */
export function computeRetryDelayMs(input: {
  attempt: number;
  policy: SearchRetryPolicy;
  retryAfterMs: number | null;
}): number {
  if (input.retryAfterMs !== null) return clampDelay(input.retryAfterMs);
  const exponent = Math.max(0, input.attempt - 1);
  return clampDelay(input.policy.baseDelayMs * 2 ** exponent);
}

function clampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
