import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { LlmFailureCategory } from "../llm/reliability/index.js";

import { applyMigrations } from "./task-schema.js";
import {
  TASK_LAST_ERROR_MAX_LENGTH,
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskStateError,
  TaskValidationError,
  type TaskOrigin,
  type TaskRecord,
  type TaskStatus,
} from "./task-types.js";

export interface TaskStoreOptions {
  dbFile: string;
}

export interface TaskCreateInput {
  sessionId: string;
  userMessage: string;
  origin: TaskOrigin;
  maxAttempts: number;
  maxSteps?: number | null;
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
  session_id: string;
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
  private readonly markRunningStmt: Database.Statement;
  private readonly markCompletedStmt: Database.Statement;
  private readonly markFailedStmt: Database.Statement;
  private readonly markRetryStmt: Database.Statement;
  private readonly markBlockedStmt: Database.Statement;
  private readonly markCancelledStmt: Database.Statement;
  private readonly recoverStaleStmt: Database.Statement;

  constructor(options: TaskStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new Database(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);

    this.insertStmt = this.db.prepare(
      `INSERT INTO tasks (
         id, session_id, user_message, max_steps, status, origin,
         attempts, max_attempts, last_error, last_error_cat,
         created_at, updated_at, started_at, completed_at
       ) VALUES (
         @id, @session_id, @user_message, @max_steps, @status, @origin,
         @attempts, @max_attempts, @last_error, @last_error_cat,
         @created_at, @updated_at, @started_at, @completed_at
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
  }

  create(input: TaskCreateInput, now: number = Date.now()): TaskRecord {
    const sessionId = validateSessionId(input.sessionId);
    const userMessage = validateUserMessage(input.userMessage);
    const maxAttempts = validateMaxAttempts(input.maxAttempts);
    const maxSteps = validateMaxSteps(input.maxSteps);
    const id = input.id ?? `t-${randomUUID()}`;
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
  };
}

function validateSessionId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TaskValidationError("sessionId", "sessionId must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TaskValidationError("sessionId", "sessionId must be non-empty");
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
