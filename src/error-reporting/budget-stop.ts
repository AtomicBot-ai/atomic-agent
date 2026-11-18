/**
 * "A budget cap the operator set was reached" (ATO-1677).
 *
 * When a fusion turn reaches its money or time cap, `fusion.delegate`
 * aborts the workers still running with a `FusionBudgetStopError`, and
 * each request cut short rejects with it: on its own, as the `cause` of
 * a wrapper, or as the `cause` of an `AbortError`. That is the cap
 * working, not a defect, and the rows and the tool result already tell
 * the person which cap was reached. Matched by name, so this module
 * takes no import from the tools layer.
 *
 * A `RequestTooLargeError` is NOT matched by itself: a real context
 * overflow still reports. Only one whose `cause` chain holds a budget
 * stop is dropped, the same as any other wrapper.
 */
const BUDGET_STOP_ERROR_NAMES: ReadonlySet<string> = new Set([
  "FusionBudgetStopError",
]);

/** Depth cap on the `cause` walk: a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** True when `err` or its `cause` chain is a budget stop. */
export function isBudgetStopError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string" && BUDGET_STOP_ERROR_NAMES.has(name)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
