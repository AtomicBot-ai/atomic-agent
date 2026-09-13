import { describeReason } from "./describe-reason.js";

/** One chain link that failed before the link whose error was thrown. */
export interface FailedAttempt {
  readonly providerId: string;
  readonly error: unknown;
}

/**
 * Side table from a thrown error to the links that failed before it.
 *
 * Deliberately not a property on the error. Everything downstream of the
 * chain decides on the error itself — `classifyFailure` and
 * `isNetworkError` match its class, its `cause` and an anchored
 * `/^fetch failed$/`, the outage wait reads its status, the TUI's
 * dropped-connection hint matches `/^terminated$/`, the Sentry scrubber
 * reads its name, code and `cause` — and a record kept beside the error
 * cannot move any of those. The thrown object is the one the last link
 * threw, byte for byte.
 */
const ATTEMPTS = new WeakMap<object, readonly FailedAttempt[]>();

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Record that `err` was thrown after `attempts` had already failed. A
 * primitive throw has nowhere to hang the record and is left alone.
 */
export function attachFailedAttempts(
  err: unknown,
  attempts: readonly FailedAttempt[],
): void {
  if (attempts.length === 0) return;
  if (typeof err !== "object" || err === null) return;
  ATTEMPTS.set(err, [...attempts]);
}

/**
 * The links that failed before `err`, searched through its `cause` chain:
 * the step executor re-wraps a raw provider failure in a `TransportError`
 * whose `cause` is the error the chain threw.
 */
export function readFailedAttempts(err: unknown): readonly FailedAttempt[] {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const found = ATTEMPTS.get(current);
    if (found) return found;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return [];
}

/**
 * The suffix a failure line carries when the chain fell over before it
 * failed: ` (after "openrouter" failed: openai provider 404: …)`, or `""`
 * when there was no fallover — so a single-link failure renders exactly
 * as it always has. Each reason is one line, capped by `describeReason`.
 */
export function describeFailedAttempts(err: unknown): string {
  const attempts = readFailedAttempts(err);
  if (attempts.length === 0) return "";
  const parts = attempts.map(
    (a) => `"${a.providerId}" failed: ${describeReason(a.error)}`,
  );
  return ` (after ${parts.join("; ")})`;
}

/**
 * The same record in a structured shape, for surfaces that keep the last
 * link's message verbatim and carry the earlier links beside it (the
 * trace `error` row).
 */
export function summarizeFailedAttempts(
  err: unknown,
): { providerId: string; reason: string }[] {
  return readFailedAttempts(err).map((a) => ({
    providerId: a.providerId,
    reason: describeReason(a.error),
  }));
}
