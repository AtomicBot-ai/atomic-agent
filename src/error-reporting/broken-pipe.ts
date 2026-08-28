/**
 * "The other end of our stdio went away."
 *
 * Two shapes reach us in production, both as *uncaught exceptions* from
 * an asynchronous write:
 *
 *  - `EPIPE` — the sidecar's host (the desktop app) exited, so the next
 *    NDJSON event write hits a closed pipe;
 *  - `EIO`   — the controlling tty is gone (terminal window closed,
 *    SIGHUP, a detached tmux pane), so the TUI's frame write fails.
 *
 * Neither is a defect in the agent. Left unhandled they kill a healthy
 * process with a raw stack trace and ship a Sentry event for a peer that
 * is simply no longer there.
 */
const BROKEN_PIPE_CODES = new Set([
  "EPIPE",
  "EIO",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/** Depth cap on the `cause` walk — a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when `err` (or anything in its `cause` chain) is a write failure
 * against a stdio stream whose far end has closed.
 */
export function isBrokenPipeError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && BROKEN_PIPE_CODES.has(code)) return true;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}
