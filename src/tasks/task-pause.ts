import type { TaskStore } from "./task-store.js";
import type { TaskRecord } from "./task-types.js";

/**
 * Pause and resume for recurring tasks as Telegram `/cron` sees them
 * (ATO-21). The state itself is the task queue's own `paused` status
 * (ATO-590: `TaskStore.pause` / `TaskStore.resume`, the same model the
 * CLI, HTTP and desktop "Pause" use). This file only adds what a chat
 * command needs on top: a refusal reason instead of an exception, and
 * the rule that only scheduled (recurring) tasks are paused here.
 *
 *  - pause:  `pending -> paused`. The scheduler and every drain only pick
 *    `pending` rows, so a paused task never fires. A run in progress is
 *    refused (`running`): it ends first.
 *  - resume: `paused -> pending`, armed for the next firing after now;
 *    firings that fell inside the pause are skipped, not caught up.
 *
 * Deleting a paused task is the plain cancel: `paused -> cancelled` is a
 * store transition.
 */

/** Why a pause, resume or delete did nothing. */
export type TaskPauseRefusal =
  | "not_found"
  | "not_recurring"
  | "running"
  | "already_paused"
  | "not_paused"
  | "ended";

export type TaskPauseResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: TaskPauseRefusal; task: TaskRecord | null };

/** True for a task in the queue's `paused` state. */
export function isPausedTask(task: TaskRecord): boolean {
  return task.status === "paused";
}

/** Stop a recurring task from firing until it is resumed. */
export function pauseRecurringTask(
  store: TaskStore,
  id: string,
  now: number = Date.now(),
): TaskPauseResult {
  const task = store.get(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (!task.recurring || !task.schedule) {
    return { ok: false, reason: "not_recurring", task };
  }
  if (isPausedTask(task)) return { ok: false, reason: "already_paused", task };
  if (task.status === "running") return { ok: false, reason: "running", task };
  if (task.status !== "pending") return { ok: false, reason: "ended", task };
  // `better-sqlite3` is synchronous: nothing in this process claims the
  // row between the read above and this write.
  const paused = store.pause(id, now);
  if (!paused) return { ok: false, reason: "not_found", task: null };
  return { ok: true, task: paused };
}

/** Rearm a paused recurring task for its next firing after `now`. */
export function resumeRecurringTask(
  store: TaskStore,
  id: string,
  now: number = Date.now(),
): TaskPauseResult {
  const task = store.get(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (!task.recurring || !task.schedule) {
    return { ok: false, reason: "not_recurring", task };
  }
  if (!isPausedTask(task)) return { ok: false, reason: "not_paused", task };
  const resumed = store.resume(id, now);
  if (!resumed) return { ok: false, reason: "not_found", task: null };
  return { ok: true, task: resumed };
}
