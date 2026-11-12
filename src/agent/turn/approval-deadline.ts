/**
 * The task's time limit, applied to a step parked on an approval prompt
 * (ATO-1367).
 *
 * The loop checks its wall-clock ceiling only when a step starts, and a
 * tool waiting for approval waits until someone answers. An unattended
 * run (the desktop's "Run overnight") with nobody to answer would then
 * sit on the prompt past its limit until morning. Once the limit
 * passes, every approval this session is waiting on is denied with a
 * plain reason, and again every few seconds while the step runs, so a
 * second prompt in the same step cannot park it either. The next step
 * sees the ceiling and writes the closing summary.
 *
 * Only for a turn whose caller set the time limit (a task run), so an
 * ordinary chat turn is never denied behind a person's back.
 */
export const APPROVAL_TIME_LIMIT_REASON =
  "The time limit for this task was reached while this action waited for approval; it was not run.";

/** How often, once past the limit, a new prompt is denied. */
export const APPROVAL_DEADLINE_REPEAT_MS = 5_000;

/**
 * The longest delay `setTimeout` honours. Node runs a larger one after
 * 1 ms, which would deny every prompt at once under a limit of more
 * than ~24.8 days; such a wait is split into hops of at most this.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export interface ApprovalDeadlineTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: ApprovalDeadlineTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Arm the limit for one step. `msLeft` is what the task has left when
 * the step starts; `deny` denies the session's pending prompts. Returns
 * the disposer to call when the step ends.
 */
export function armApprovalDeadline(input: {
  msLeft: number;
  deny: (reason: string) => void;
  timers?: ApprovalDeadlineTimers;
  now?: () => number;
}): () => void {
  const timers = input.timers ?? realTimers;
  const now = input.now ?? Date.now;
  if (!Number.isFinite(input.msLeft)) return () => undefined;
  const deadline = now() + Math.max(0, input.msLeft);
  let repeat: unknown = null;
  let pending: unknown = null;
  const fire = (): void => {
    try {
      input.deny(APPROVAL_TIME_LIMIT_REASON);
    } catch {
      // A failing gate must not take the step down with it.
    }
  };
  const arm = (): void => {
    const left = deadline - now();
    if (left > MAX_TIMER_MS) {
      // Not there yet: wait one full hop and look again.
      pending = timers.setTimeout(arm, MAX_TIMER_MS);
      return;
    }
    pending = timers.setTimeout(() => {
      pending = null;
      fire();
      repeat = timers.setInterval(fire, APPROVAL_DEADLINE_REPEAT_MS);
    }, Math.max(0, left));
  };
  arm();
  return () => {
    if (pending !== null) timers.clearTimeout(pending);
    if (repeat !== null) timers.clearInterval(repeat);
  };
}
