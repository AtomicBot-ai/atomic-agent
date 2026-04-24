import type { LlmFailureCategory } from "../llm/reliability/index.js";

/**
 * Lifecycle of a durable task. The transitions are linear with one
 * exception (a `running` task can revert to `pending` either via
 * `recoverStale` after a process crash, or via the runner when a
 * retryable failure remains under `maxAttempts`):
 *
 *   pending  -> running -> { completed | failed | blocked | cancelled }
 *   running  -> pending  (retry-eligible failure, or stale-orphan recovery)
 *   pending  -> cancelled (operator cancellation before pickup)
 *
 * Recurring tasks add one more legal arrow:
 *
 *   completed -> pending  (requeued by the runner with a fresh `scheduled_for`)
 *
 * This is the only path that resets `attempts`/`last_error`/`started_at`/
 * `completed_at` on an already-terminal row; `session_id` is preserved
 * across requeues so the recurring task's conversation stays continuous.
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * Where the task was created. Mirrors `TurnOrigin` but kept as its own
 * type because the legal set is wider — a task can be filed by HTTP
 * even when no live `runTurn` initiated it.
 */
export type TaskOrigin =
  | "cli"
  | "tui"
  | "http"
  | "sidecar"
  | "scheduler"
  | "agent";

/**
 * Who ultimately triggered the task. Informational only — used for
 * observability and for populating `session.metadata.wakeReason` when
 * the task enters `runTurn`. `origin` captures the API surface (e.g.
 * `http`), `triggerSource` captures the semantic reason (`webhook`).
 */
export type TriggerSource = "user" | "scheduler" | "webhook" | "agent";

/**
 * Scheduling primitive for deferred / recurring execution. Three shapes:
 *
 *  - `at`: single wall-clock Unix ms — fires once then stays in a
 *    terminal status.
 *  - `cron`: standard 5- or 6-field expression, optional IANA `tz`.
 *  - `interval`: fires every `everyMs` starting from the creation time
 *    and requeues itself forward on each completion.
 *
 * `cron` and `interval` are recurring (`isRecurring` returns `true`);
 * `at` is one-shot.
 */
export type TaskSchedule =
  | { kind: "at"; at: number }
  | { kind: "cron"; expression: string; tz?: string }
  | { kind: "interval"; everyMs: number };

/**
 * Durable record of a deferred `runTurn` submission.
 *
 * Persistence layout: see [src/tasks/task-schema.ts](task-schema.ts).
 */
export interface TaskRecord {
  id: string;
  /**
   * Session the task will run in. `null` for one-shot tasks that do
   * not carry an explicit session — the runner creates one lazily at
   * the first `runOne` attempt and writes it back so subsequent reads
   * observe a stable id. Recurring tasks always carry a non-null
   * session (created at `create()` time and reused across firings);
   * the runner auto-recreates it if it ever goes missing.
   */
  sessionId: string | null;
  userMessage: string;
  /**
   * Per-task override for `agent.maxSteps`. `null` falls back to the
   * runtime config at execution time so existing rows survive a config
   * change without rewriting every payload.
   */
  maxSteps: number | null;
  status: TaskStatus;
  origin: TaskOrigin;
  /** Number of execution attempts made so far. Bumped before each `runTurn`. */
  attempts: number;
  /** Hard cap on `attempts`; once reached on a retryable failure the task moves to `failed`. */
  maxAttempts: number;
  /** Most recent error message (truncated by `TASK_LAST_ERROR_MAX_LENGTH`). */
  lastError: string | null;
  /** Most recent failure category from `LlmFailureCategory` (or `null` if never failed). */
  lastErrorCategory: LlmFailureCategory | null;
  createdAt: number;
  updatedAt: number;
  /** Wall-clock start of the latest run. Reset on retry. */
  startedAt: number | null;
  /** Wall-clock terminal-status timestamp (set for completed/failed/blocked/cancelled). */
  completedAt: number | null;
  /** Scheduling primitive. `null` for eager one-shot tasks (immediate drain). */
  schedule: TaskSchedule | null;
  /**
   * Next Unix ms at which the scheduler should pick this row up. `null`
   * means "immediately" and matches the pre-v2 behaviour for tasks
   * without a schedule; the scheduler picks both nulls and past
   * timestamps.
   */
  scheduledFor: number | null;
  /** True for `cron` and `interval` schedules. Denormalised for fast filtering. */
  recurring: boolean;
  /** Wall-clock of the most recent schedule resolution (last `scheduled_for` write). */
  lastScheduledAt: number | null;
  /** Informational trigger source (see `TriggerSource`). */
  triggerSource: TriggerSource | null;
}

/**
 * Hard upper bound on a single user message. Guards SQLite payload
 * growth and matches the spirit of `PROFILE_VALUE_MAX_LENGTH` from the
 * memory layer. Real chat turns rarely exceed a few KB; anything past
 * the limit is rejected at create time with a `TaskValidationError`.
 */
export const TASK_USER_MESSAGE_MAX_LENGTH = 16_000;

/**
 * Truncation cap for `lastError`. The error itself is logged in full
 * via the structured logger; the on-row copy exists only for quick
 * inspection through `task list` / `GET /tasks/:id`.
 */
export const TASK_LAST_ERROR_MAX_LENGTH = 2_000;

/**
 * Validation error raised by `TaskStore.create` and the HTTP/CLI
 * surfaces. Carries the offending field so callers can surface a
 * targeted 400 response.
 */
export class TaskValidationError extends Error {
  constructor(
    public readonly field:
      | "sessionId"
      | "userMessage"
      | "maxSteps"
      | "maxAttempts"
      | "id"
      | "schedule",
    message: string,
  ) {
    super(message);
    this.name = "TaskValidationError";
  }
}

/**
 * Raised when a status transition violates the lifecycle. Used by
 * `TaskStore` so the runner cannot accidentally drag a `completed` row
 * back into `running`.
 */
export class TaskStateError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly id: string,
  ) {
    super(`task ${id}: illegal transition ${from} -> ${to}`);
    this.name = "TaskStateError";
  }
}
