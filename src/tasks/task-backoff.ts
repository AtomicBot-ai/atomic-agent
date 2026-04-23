/**
 * Pure exponential-capped backoff for task retries.
 *
 * `attempt` is 1-indexed: it is the number of attempts that have
 * already finished and failed. The first retry (after attempt 1) waits
 * `initialMs`, then `2 * initialMs`, then `4 * initialMs`, and so on
 * until the result is clipped to `maxMs`.
 *
 * No jitter — this is a deterministic helper so the runner stays easy
 * to reason about under tests. If we ever need decorrelated jitter, it
 * lands here as a separate exported function.
 */
export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
}

export function nextDelayMs(attempt: number, options: BackoffOptions): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  if (options.initialMs <= 0) return 0;
  if (options.maxMs <= 0) return 0;
  const exponent = Math.min(attempt - 1, 30);
  const raw = options.initialMs * Math.pow(2, exponent);
  if (!Number.isFinite(raw)) return options.maxMs;
  return Math.min(raw, options.maxMs);
}
