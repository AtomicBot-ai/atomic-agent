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
export type TaskOrigin = "cli" | "tui" | "http" | "sidecar" | "scheduler";

/**
 * Durable record of a deferred `runTurn` submission. Every task in the
 * milestone is exactly one `(sessionId, userMessage)` pair — no `kind`
 * discriminator is stored. If a future option needs another shape, it
 * adds a column via a v2 schema migration.
 *
 * Persistence layout: see [src/tasks/task-schema.ts](task-schema.ts).
 */
export interface TaskRecord {
  id: string;
  sessionId: string;
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
    public readonly field: "sessionId" | "userMessage" | "maxSteps" | "maxAttempts" | "id",
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
