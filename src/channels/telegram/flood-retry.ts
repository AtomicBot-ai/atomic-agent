/**
 * Telegram flood-wait (HTTP 429) handling shared by the outbound sender
 * and the streamed live reply (ATO-634). Telegram answers a bot that
 * sends too fast with `{ error_code: 429, parameters: { retry_after } }`;
 * the right response is to wait that long and send the same thing again.
 * Retrying only once (the old sender) lost a chunk of the answer on the
 * second 429 in a row, which a burst of long replies hits easily.
 */

/**
 * Total time one call may spend waiting on flood-waits before giving up.
 * Bot-side flood-waits are a few seconds in practice; three minutes of
 * continuous 429s means the bot is being throttled hard, and blocking the
 * chat longer than that would hide the problem rather than ride it out.
 */
export const FLOOD_RETRY_BUDGET_MS = 180_000;

/**
 * `retry_after` seconds from a Telegram 429, or `null` for any other
 * error. A 429 without a usable `retry_after` waits one second, so a
 * malformed answer still backs off instead of hammering the limit.
 * Structural, so it reads grammy's `GrammyError` and hand-rolled fakes.
 */
export function floodWaitSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    error_code?: unknown;
    parameters?: { retry_after?: unknown } | undefined;
  };
  if (e.error_code !== 429) return null;
  const value = e.parameters?.retry_after;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

export interface FloodRetryOptions {
  /** Test seam: replaces `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Total wait allowed across all retries; defaults to {@link FLOOD_RETRY_BUDGET_MS}. */
  budgetMs?: number;
  /** Told about each wait, for logs. */
  onWait?: (waitMs: number, attempt: number) => void;
}

/**
 * Run `call`, and on every 429 wait the `retry_after` Telegram asked for
 * and run it again, until it succeeds, fails with anything other than a
 * 429, or the waits would exceed the budget. Throws the last error in the
 * last two cases, so the caller decides what a failure means.
 */
export async function callWithFloodRetry<T>(
  call: () => Promise<T>,
  opts: FloodRetryOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const budget = opts.budgetMs ?? FLOOD_RETRY_BUDGET_MS;
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const seconds = floodWaitSeconds(err);
      if (seconds === null) throw err;
      const waitMs = Math.ceil(seconds * 1000);
      if (waited + waitMs > budget) throw err;
      waited += waitMs;
      opts.onWait?.(waitMs, attempt);
      await sleep(waitMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
