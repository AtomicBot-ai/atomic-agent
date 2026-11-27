/**
 * "The person's Claude Code or Codex account cannot serve this turn"
 * (ATO-2417).
 *
 * A signed-out or expired login (`SubscriptionCliAuthError`), a spent
 * usage or rate limit, and a plan that does not include the CLI
 * (`SubscriptionCliInvocationError` with `failureKind` `limit_reached`
 * or `plan_required`) are the account's state, not a defect: the turn
 * already ends with the CLI's own words and the next step ("run
 * `claude` and complete /login", "run `codex login`"). They reached
 * Sentry as one event per failed turn (CLI-K2, CLI-JQ), which buried
 * the failures that are ours. Same pattern as Atomic Chat not running
 * (ATO-1278) and a fusion stop (ATO-1677).
 *
 * Matched by name and by the fixed `failureKind` word anywhere in the
 * `cause` chain (the step hands the report a wrapper), so this module
 * takes no import from the LLM layer. Every other CLI failure (an exit
 * with an unknown reason, a timeout, a spawn failure, not installed)
 * still reports.
 */
const AUTH_ERROR_NAME = "SubscriptionCliAuthError";
const INVOCATION_ERROR_NAME = "SubscriptionCliInvocationError";

/** Mirror of the account-state kinds of `SubscriptionCliFailureKind`. */
const ACCOUNT_STATE_KINDS: ReadonlySet<string> = new Set([
  "limit_reached",
  "plan_required",
]);

/** Depth cap on the `cause` walk: a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** True when `err` or its `cause` chain is an account state of a subscription CLI. */
export function isExpectedSubscriptionCliFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const { name, failureKind } = current as { name?: unknown; failureKind?: unknown };
    if (name === AUTH_ERROR_NAME) return true;
    if (name === INVOCATION_ERROR_NAME) {
      return typeof failureKind === "string" && ACCOUNT_STATE_KINDS.has(failureKind);
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}
