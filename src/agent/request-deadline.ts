/**
 * The task's wall-clock ceiling, applied to one completion request.
 *
 * `agent.task.maxDurationMs` used to be checked only when a step
 * started; the request itself carried the user's abort signal alone. A
 * turn that entered a provider wait — a queued local server, a
 * 20-minute prompt evaluation, a cloud request that never answered —
 * sailed past its two-hour window inside that wait and had to be closed
 * by hand. The ceiling is a promise the durable-task ruling makes, so
 * the request gets a signal that fires at the ceiling: the user's signal
 * composed with a timer for the time the task has left.
 *
 * Firing is not a cancellation. The loop reads `fired()` to tell "the
 * ceiling bit mid-request" from "the user pressed Ctrl+C", treats the
 * former as `time_ceiling`, and runs the summary step on a fresh
 * deadline of its own — llama-server keeps decoding the abandoned
 * request until it notices the closed connection, so the summary queues
 * behind it for a while and needs room.
 */
export interface RequestDeadline {
  /** Aborts on the user's signal or when `budgetMs` elapses. */
  signal: AbortSignal;
  /** True once the timer, not the user, aborted the signal. */
  fired: () => boolean;
  /** Clear the timer and detach from the user's signal. */
  dispose: () => void;
}

/**
 * The summary step's own budget once the ceiling has bitten: a step
 * after a mid-request expiry is not a step the task has time for, but a
 * turn cut off with no summary is worse than one that ran five minutes
 * over.
 */
export const FINALIZATION_REQUEST_DEADLINE_MS = 5 * 60_000;

export function createRequestDeadline(
  userSignal: AbortSignal,
  budgetMs: number,
): RequestDeadline {
  const controller = new AbortController();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onUserAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(userSignal.reason);
  };
  if (userSignal.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal.addEventListener("abort", onUserAbort, { once: true });
    // A budget that is not a finite positive number means the ceiling is
    // already here (or is not a number the loop can plan against):
    // `setTimeout` with a huge value fires at once, and one with `NaN`
    // fires at once too, so both are handled by hand.
    const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0;
    const MAX_TIMER_MS = 2_147_483_647;
    timer = setTimeout(
      () => {
        timer = null;
        if (controller.signal.aborted) return;
        fired = true;
        controller.abort(new Error("task time ceiling reached mid-request"));
      },
      Math.min(budget, MAX_TIMER_MS),
    );
  }
  return {
    signal: controller.signal,
    fired: () => fired,
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      userSignal.removeEventListener("abort", onUserAbort);
    },
  };
}
