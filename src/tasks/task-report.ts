import type { LlmFailureCategory } from "../llm/reliability/index.js";

import type { TaskRecord, TaskSchedule, TaskStatus } from "./task-types.js";

/**
 * Terminal statuses that produce a report. Retries (`running ->
 * pending`) and `cancelled` never report: a retry is not an outcome
 * yet, and cancellation is operator-initiated or shutdown-driven —
 * racing a notification against channel teardown would be noise.
 */
export type TaskReportStatus = Extract<
  TaskStatus,
  "completed" | "failed" | "blocked"
>;

/**
 * Snapshot of a task's terminal outcome handed to the report sink.
 * `replyText` is the final assistant reply captured live via the
 * turn's event hook (completed runs only; `null` when the turn ended
 * without a reply). Error fields mirror the row's `lastError` /
 * `lastErrorCategory` at terminal time.
 */
export interface TaskReport {
  taskId: string;
  status: TaskReportStatus;
  /** The task's prompt — lets the recipient recognise which job fired. */
  userMessage: string;
  /** `null` for eager (unscheduled) one-shot tasks. */
  scheduleKind: TaskSchedule["kind"] | null;
  attempts: number;
  maxAttempts: number;
  /** `completedAt - startedAt`; `null` when either timestamp is missing. */
  durationMs: number | null;
  replyText: string | null;
  errorMessage: string | null;
  errorCategory: LlmFailureCategory | null;
}

/**
 * Delivery seam wired in bootstrap (the Telegram channel today — the
 * only member of `TASK_NOTIFY_TARGETS`; a second target turns the
 * sink into a per-target dispatch). Invoked fire-and-forget by the
 * runner: a throwing or rejecting sink is warn-logged and never
 * affects the task's own status.
 */
export type TaskReportSink = (report: TaskReport) => void | Promise<void>;

/** Allow-list gate for the statuses in `TaskReportStatus`. */
export function isReportableStatus(
  status: TaskStatus,
): status is TaskReportStatus {
  return status === "completed" || status === "failed" || status === "blocked";
}

/**
 * Project a terminal `TaskRecord` into the report shape. Pure — the
 * runner owns when to call it (terminal transitions only) and how to
 * dispatch the result. `status` is passed separately because narrowing
 * `task.status` via `isReportableStatus` does not narrow `task` itself.
 */
export function buildTaskReport(
  task: TaskRecord,
  status: TaskReportStatus,
  replyText: string | null,
): TaskReport {
  return {
    taskId: task.id,
    status,
    userMessage: task.userMessage,
    scheduleKind: task.schedule?.kind ?? null,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    durationMs:
      task.completedAt !== null && task.startedAt !== null
        ? task.completedAt - task.startedAt
        : null,
    replyText,
    errorMessage: task.lastError,
    errorCategory: task.lastErrorCategory,
  };
}
