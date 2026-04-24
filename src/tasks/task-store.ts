import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { LlmFailureCategory } from "../llm/reliability/index.js";

import { applyMigrations } from "./task-schema.js";
import {
  parseScheduleRow,
  serializeScheduleValue,
} from "./task-schedule.js";
import {
  TASK_LAST_ERROR_MAX_LENGTH,
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskStateError,
  TaskValidationError,
  type TaskOrigin,
  type TaskRecord,
  type TaskSchedule,
  type TaskStatus,
  type TriggerSource,
} from "./task-types.js";

export interface TaskStoreOptions {
  dbFile: string;
}

export interface TaskCreateInput {
  /**
   * Session the task will run in. `null` (or omitted) persists the row
   * with `session_id = NULL` and lets `TaskRunner.runOne` create a
   * fresh ephemeral session lazily at the first attempt.
   */
  sessionId?: string | null;
  userMessage: string;
  origin: TaskOrigin;
  maxAttempts: number;
  maxSteps?: number | null;
  /** Scheduling primitive; omit for an eager one-shot task (immediate drain). */
  schedule?: TaskSchedule | null;
  /**
   * Initial `scheduled_for` timestamp. The runner derives this from
   * `schedule` via `resolveScheduledFor`; tests may pass it directly
   * to skip the computation.
   */
  scheduledFor?: number | null;
  /** Informational trigger tag — surfaced on `session.metadata.wakeReason`. */
  triggerSource?: TriggerSource | null;
  /**
   * Optional explicit id. Used by tests to make assertions; production
   * callers always let the store generate one.
   */
  id?: string;
}

export interface TaskListOptions {
  sessionId?: string;
  status?: TaskStatus | TaskStatus[];
  limit?: number;
}

export interface TaskFailureInput {
  category: LlmFailureCategory;
  message: string;
}

interface TaskRow {
  id: string;
  session_id: string | null;
  user_message: string;
  max_steps: number | null;
  status: TaskStatus;
  origin: TaskOrigin;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  last_error_cat: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  schedule_kind: string | null;
  schedule_value: string | null;
  scheduled_for: number | null;
  recurring: number;
  last_scheduled_at: number | null;
  trigger_source: string | null;
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

/**
 * Durable task queue backed by `better-sqlite3`. All methods are
 * synchronous because the volume is small (per-session double-digit
 * counts in normal use) and `better-sqlite3` is already synchronous.
 *
 * Cross-session safety relies on the same load-bearing assumption as
 * `ProfileStore` / `MemoryStore` / `SessionStore` (see
 * `ARCHITECTURE.md` §4.15): synchronous statements have no race window
 * between read and write.
 */
export class TaskStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;
  private readonly listBySessionStmt: Database.Statement;
  private readonly listPendingStmt: Database.Statement;
  private readonly listPendingBySessionStmt: Database.Statement;
  private readonly listDueStmt: Database.Statement;
  private readonly markRunningStmt: Database.Statement;
  private readonly markCompletedStmt: Database.Statement;
  private readonly markFailedStmt: Database.Statement;
  private readonly markRetryStmt: Database.Statement;
  private readonly markBlockedStmt: Database.Statement;
  private readonly markCancelledStmt: Database.Statement;
  private readonly recoverStaleStmt: Database.Statement;
  private readonly requeueRecurringStmt: Database.Statement;
  private readonly assignSessionStmt: Database.Statement;

  constructor(options: TaskStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new Database(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);

    this.insertStmt = this.db.prepare(
      `INSERT INTO tasks (
         id, session_id, user_message, max_steps, status, origin,
         attempts, max_attempts, last_error, last_error_cat,
         created_at, updated_at, started_at, completed_at,
         schedule_kind, schedule_value, scheduled_for, recurring,
         last_scheduled_at, trigger_source
       ) VALUES (
         @id, @session_id, @user_message, @max_steps, @status, @origin,
         @attempts, @max_attempts, @last_error, @last_error_cat,
         @created_at, @updated_at, @started_at, @completed_at,
         @schedule_kind, @schedule_value, @scheduled_for, @recurring,
         @last_scheduled_at, @trigger_source
       )`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE id = ?`,
    );
    this.listAllStmt = this.db.prepare(
      `SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`,
    );
    this.listBySessionStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.listPendingStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    );
    this.listPendingBySessionStmt = this.db.prepare(
      `SELECT * FROM tasks
         WHERE status = 'pending' AND session_id = ?
         ORDER BY created_at ASC LIMIT ?`,
    );
    this.listDueStmt = this.db.prepare(
      `SELECT * FROM tasks
         WHERE status = 'pending'
           AND (scheduled_for IS NULL OR scheduled_for <= ?)
         ORDER BY scheduled_for ASC, created_at ASC
         LIMIT ?`,
    );
    this.markRunningStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'running',
              attempts = attempts + 1,
              started_at = @now,
              updated_at = @now,
              last_error = NULL,
              last_error_cat = NULL
        WHERE id = @id AND status = 'pending'`,
    );
    this.markCompletedStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'completed',
              completed_at = @now,
              updated_at = @now,
              last_error = NULL,
              last_error_cat = NULL
        WHERE id = @id AND status = 'running'`,
    );
    this.markFailedStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'failed',
              completed_at = @now,
              updated_at = @now,
              last_error = @last_error,
              last_error_cat = @last_error_cat
        WHERE id = @id AND status = 'running'`,
    );
    this.markRetryStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              updated_at = @now,
              started_at = NULL,
              last_error = @last_error,
              last_error_cat = @last_error_cat
        WHERE id = @id AND status = 'running'`,
    );
    this.markBlockedStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'blocked',
              completed_at = @now,
              updated_at = @now,
              last_error = @last_error,
              last_error_cat = @last_error_cat
        WHERE id = @id AND status IN ('running', 'pending')`,
    );
    this.markCancelledStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'cancelled',
              completed_at = @now,
              updated_at = @now
        WHERE id = @id AND status IN ('pending', 'running')`,
    );
    this.recoverStaleStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              updated_at = @now,
              started_at = NULL,
              last_error = COALESCE(last_error, 'recovered from stale running'),
              last_error_cat = COALESCE(last_error_cat, 'transport')
        WHERE status = 'running' AND started_at IS NOT NULL AND started_at < @threshold`,
    );
    this.requeueRecurringStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              attempts = 0,
              last_error = NULL,
              last_error_cat = NULL,
              started_at = NULL,
              completed_at = NULL,
              scheduled_for = @scheduled_for,
              last_scheduled_at = @now,
              updated_at = @now
        WHERE id = @id AND recurring = 1`,
    );
    this.assignSessionStmt = this.db.prepare(
      `UPDATE tasks
          SET session_id = @session_id,
              updated_at = @now
        WHERE id = @id`,
    );
  }

  create(input: TaskCreateInput, now: number = Date.now()): TaskRecord {
    const sessionId = validateSessionId(input.sessionId ?? null);
    const userMessage = validateUserMessage(input.userMessage);
    const maxAttempts = validateMaxAttempts(input.maxAttempts);
    const maxSteps = validateMaxSteps(input.maxSteps);
    const id = input.id ?? `t-${randomUUID()}`;
    const schedule = input.schedule ?? null;
    const recurring =
      schedule && (schedule.kind === "cron" || schedule.kind === "interval")
        ? 1
        : 0;
    const row: TaskRow = {
      id,
      session_id: sessionId,
      user_message: userMessage,
      max_steps: maxSteps,
      status: "pending",
      origin: input.origin,
      attempts: 0,
      max_attempts: maxAttempts,
      last_error: null,
      last_error_cat: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      schedule_kind: schedule?.kind ?? null,
      schedule_value: schedule ? serializeScheduleValue(schedule) : null,
      scheduled_for: input.scheduledFor ?? null,
      recurring,
      last_scheduled_at:
        input.scheduledFor !== undefined && input.scheduledFor !== null
          ? now
          : null,
      trigger_source: input.triggerSource ?? null,
    };
    this.insertStmt.run(row);
    return rowToRecord(row);
  }

  get(id: string): TaskRecord | null {
    const row = this.selectStmt.get(id) as TaskRow | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }

  list(options: TaskListOptions = {}): TaskRecord[] {
    const limit = options.limit ?? 100;
    const rows = options.sessionId
      ? (this.listBySessionStmt.all(options.sessionId, limit) as TaskRow[])
      : (this.listAllStmt.all(limit) as TaskRow[]);
    if (!options.status) return rows.map(rowToRecord);
    const allowed = Array.isArray(options.status)
      ? new Set(options.status)
      : new Set([options.status]);
    return rows.filter((r) => allowed.has(r.status)).map(rowToRecord);
  }

  /**
   * Pull the next batch of `pending` tasks in FIFO (oldest-first) order.
   * `sessionId` narrows the slice to a single session — the runner uses
   * this when an HTTP `POST /tasks/:id/run` targets one task and we want
   * to drain only its session.
   */
  listPending(options: { sessionId?: string; limit?: number } = {}): TaskRecord[] {
    const limit = options.limit ?? 100;
    const rows = options.sessionId
      ? (this.listPendingBySessionStmt.all(options.sessionId, limit) as TaskRow[])
      : (this.listPendingStmt.all(limit) as TaskRow[]);
    return rows.map(rowToRecord);
  }

  /**
   * Pull every `pending` task that is due at `now` — either unscheduled
   * (null `scheduled_for`) or explicitly scheduled for the past.
   * Ordered by `scheduled_for ASC, created_at ASC` so the scheduler
   * drains overdue tasks in wall-clock order and ties break
   * deterministically. Uses the dedicated `idx_tasks_due` partial index;
   * this is the only query path the scheduler takes to find work.
   */
  listDue(now: number, limit = 100): TaskRecord[] {
    const rows = this.listDueStmt.all(now, limit) as TaskRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Atomically claim a `pending` task by flipping it to `running` and
   * incrementing `attempts`. Returns `null` when the row is not in
   * `pending` (already running, completed, cancelled by an operator
   * mid-flight, or vanished). The runner uses the `null` return to skip
   * the row without raising — concurrent drains coordinate via this
   * race.
   */
  markRunning(id: string, now: number = Date.now()): TaskRecord | null {
    const result = this.markRunningStmt.run({ id, now }) as { changes: number };
    if (result.changes === 0) return null;
    return this.get(id);
  }

  markCompleted(id: string, now: number = Date.now()): TaskRecord {
    const result = this.markCompletedStmt.run({ id, now }) as { changes: number };
    if (result.changes === 0) {
      throw this.transitionError(id, "completed");
    }
    return this.requireRecord(id);
  }

  markFailed(
    id: string,
    failure: TaskFailureInput,
    now: number = Date.now(),
  ): TaskRecord {
    const result = this.markFailedStmt.run({
      id,
      now,
      last_error: truncateError(failure.message),
      last_error_cat: failure.category,
    }) as { changes: number };
    if (result.changes === 0) {
      throw this.transitionError(id, "failed");
    }
    return this.requireRecord(id);
  }

  /**
   * Move a `running` task back to `pending` so the next drain picks it
   * up. Used when the failure category is retryable and the attempt
   * budget is not yet exhausted. The `running` -> `pending` arrow is
   * the one legal "backward" transition in the lifecycle.
   */
  markRetry(
    id: string,
    failure: TaskFailureInput,
    now: number = Date.now(),
  ): TaskRecord {
    const result = this.markRetryStmt.run({
      id,
      now,
      last_error: truncateError(failure.message),
      last_error_cat: failure.category,
    }) as { changes: number };
    if (result.changes === 0) {
      throw this.transitionError(id, "pending");
    }
    return this.requireRecord(id);
  }

  markBlocked(
    id: string,
    failure: TaskFailureInput,
    now: number = Date.now(),
  ): TaskRecord {
    const result = this.markBlockedStmt.run({
      id,
      now,
      last_error: truncateError(failure.message),
      last_error_cat: failure.category,
    }) as { changes: number };
    if (result.changes === 0) {
      throw this.transitionError(id, "blocked");
    }
    return this.requireRecord(id);
  }

  /**
   * Cancel a task. Idempotent on already-terminal rows: returns the
   * existing record unchanged (no `TaskStateError`) so the HTTP DELETE
   * surface can be retried by clients without surprises.
   */
  cancel(id: string, now: number = Date.now()): TaskRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (TERMINAL_STATUSES.has(existing.status)) return existing;
    this.markCancelledStmt.run({ id, now });
    return this.requireRecord(id);
  }

  /**
   * Flip every `running` task whose `started_at` is older than `now -
   * staleAfterMs` back to `pending`. Called once on bootstrap to handle
   * the case where the host process crashed between `markRunning` and
   * the terminal status update — without recovery these rows would sit
   * in `running` forever. No background sweeper; recovery is a one-shot
   * pass.
   */
  recoverStale(staleAfterMs: number, now: number = Date.now()): number {
    const threshold = now - staleAfterMs;
    const result = this.recoverStaleStmt.run({ now, threshold }) as { changes: number };
    return result.changes;
  }

  /**
   * Requeue a recurring task that just completed, resetting the
   * per-attempt bookkeeping so the next firing starts clean. Only
   * operates on rows flagged `recurring = 1`; one-shot tasks are
   * rejected at the SQL level so a caller bug cannot silently revive
   * a completed `at` task.
   *
   * Atomic: `attempts`, `last_error`, `started_at`, and `completed_at`
   * reset together. `session_id` is deliberately never touched — a
   * recurring task owns one persistent session for its full lifetime.
   */
  requeueRecurring(
    id: string,
    nextScheduledFor: number,
    now: number = Date.now(),
  ): TaskRecord {
    const result = this.requeueRecurringStmt.run({
      id,
      scheduled_for: nextScheduledFor,
      now,
    }) as { changes: number };
    if (result.changes === 0) {
      throw new Error(
        `task ${id}: cannot requeueRecurring — row missing or not recurring`,
      );
    }
    return this.requireRecord(id);
  }

  /**
   * Write a freshly-minted session id onto a task that was persisted
   * with `session_id = NULL`. Used by `TaskRunner.runOne` in the
   * lazy one-shot path; also used to overwrite a missing session id
   * for recurring tasks that auto-recreate their session.
   */
  assignSession(
    id: string,
    sessionId: string,
    now: number = Date.now(),
  ): TaskRecord {
    const result = this.assignSessionStmt.run({
      id,
      session_id: sessionId,
      now,
    }) as { changes: number };
    if (result.changes === 0) {
      throw new Error(`task ${id}: cannot assignSession — row missing`);
    }
    return this.requireRecord(id);
  }

  close(): void {
    this.db.close();
  }

  private requireRecord(id: string): TaskRecord {
    const record = this.get(id);
    if (!record) {
      throw new Error(`task ${id} disappeared between write and re-read`);
    }
    return record;
  }

  private transitionError(id: string, to: TaskStatus): TaskStateError {
    const current = this.get(id);
    return new TaskStateError(current?.status ?? "cancelled", to, id);
  }
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessage: row.user_message,
    maxSteps: row.max_steps,
    status: row.status,
    origin: row.origin,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    lastErrorCategory: row.last_error_cat as LlmFailureCategory | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    schedule: parseScheduleRow(row.schedule_kind, row.schedule_value),
    scheduledFor: row.scheduled_for,
    recurring: row.recurring === 1,
    lastScheduledAt: row.last_scheduled_at,
    triggerSource: row.trigger_source as TriggerSource | null,
  };
}

function validateSessionId(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new TaskValidationError("sessionId", "sessionId must be a string or null");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TaskValidationError(
      "sessionId",
      "sessionId must be non-empty when provided",
    );
  }
  return trimmed;
}

function validateUserMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TaskValidationError("userMessage", "userMessage must be a string");
  }
  if (raw.length === 0) {
    throw new TaskValidationError("userMessage", "userMessage must be non-empty");
  }
  if (raw.length > TASK_USER_MESSAGE_MAX_LENGTH) {
    throw new TaskValidationError(
      "userMessage",
      `userMessage must be at most ${TASK_USER_MESSAGE_MAX_LENGTH} chars`,
    );
  }
  return raw;
}

function validateMaxAttempts(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new TaskValidationError(
      "maxAttempts",
      `maxAttempts must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function validateMaxSteps(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new TaskValidationError(
      "maxSteps",
      `maxSteps must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function truncateError(message: string): string {
  if (message.length <= TASK_LAST_ERROR_MAX_LENGTH) return message;
  return `${message.slice(0, TASK_LAST_ERROR_MAX_LENGTH - 1)}…`;
}
