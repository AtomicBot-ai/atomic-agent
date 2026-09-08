import type { LocalModelsPullWaiting } from "./local-models-panel-state.js";

/**
 * `⏸ waiting for the network — attempt 4, next try in 32s (fetch failed)`.
 * The countdown is what it was at the last state change; the record is
 * re-read on every retry, so it is never more than one backoff old.
 */
export function describePullWaiting(
  waiting: LocalModelsPullWaiting,
  now: number = Date.now(),
): string {
  const inMs = Date.parse(waiting.nextRetryAt) - now;
  const when =
    Number.isFinite(inMs) && inMs > 0 ? `next try in ${Math.ceil(inMs / 1000)}s` : "retrying";
  return `⏸ waiting for the network — attempt ${waiting.attempt}, ${when} (${waiting.reason})`;
}
