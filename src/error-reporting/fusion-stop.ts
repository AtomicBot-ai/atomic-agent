/**
 * "A fusion worker was stopped on purpose" (ATO-1677).
 *
 * `fusion.delegate` aborts the workers still running with a
 * `FusionBudgetStopError` when a turn reaches its money or time cap, and
 * `worker-runner.ts` aborts one worker with a `FusionWorkerStopError`
 * when the person stops it, when the escalation model takes its task
 * over, when it is handed back early, or when the escalation run reaches
 * its time limit or spend cap. A request cut short rejects with that
 * reason, and the step wraps it (`toLlmFailure` files it as a
 * `ToolExecutionError` whose `cause` is the stop). That is the agent
 * doing what was asked, not a defect, and the rows and the tool result
 * already say why. Matched by name anywhere in the `cause` chain, so
 * this module takes no import from the tools layer.
 *
 * A `RequestTooLargeError` is NOT matched by itself: a real context
 * overflow still reports.
 */
const FUSION_STOP_ERROR_NAMES: ReadonlySet<string> = new Set([
  "FusionBudgetStopError",
  "FusionWorkerStopError",
]);

/** Depth cap on the `cause` walk: a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** True when `err` or its `cause` chain is a fusion stop. */
export function isFusionStopError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string" && FUSION_STOP_ERROR_NAMES.has(name)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
