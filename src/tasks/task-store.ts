import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { LlmFailureCategory } from "../llm/reliability/index.js";
import {
  currentTurnOwnerProbe,
  databaseIdentity,
  isTurnOwnerGone,
  parseTurnOwner,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "../session/turn-owner.js";

import { applyMigrations } from "./task-schema.js";
import { parseScheduleRow, serializeScheduleValue } from "./task-schedule.js";
import {
  TASK_LAST_ERROR_MAX_LENGTH,
  TASK_NOTIFY_TARGETS,
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskStateError,
  TaskValidationError,
  type TaskNotifyTarget,
  type TaskOrigin,
  type TaskRecord,
  type TaskSchedule,
  type TaskStatus,
  type TriggerSource,
} from "./task-types.js";

export interface TaskStoreOptions {
  dbFile: string;
  /**
   * The process and host a claim records as the run's owner, and that
   * `recoverInterrupted` judges an owner against. Defaults to this
   * process; tests pass their own.
   */
  ownerProbe?: TurnOwnerProbe;
}

/**
 * What `markInterrupted` writes into `last_error` (category `cancelled`):
 * the run was stopped before it could end — the agent quitting, or the
 * turn stopped under it — and the task was put back rather than ended.
 */
export const TASK_INTERRUPTED_ERROR =
  "interrupted: the run was stopped before it ended";

/** `last_error` of a row the boot sweep took back from a process that is gone. */
export const TASK_OWNER_GONE_ERROR = "interrupted: the agent running it stopped";

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
   * Terminal-outcome report channel (see `TASK_NOTIFY_TARGETS`).
   * Omit / `null` for the silent default. Anything outside the
   * allow-list is rejected with a `TaskValidationError`.
   */
  notify?: TaskNotifyTarget | null;
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
  notify: string | null;
}

interface RunningRow {
  id: string;
  started_at: number | null;
  run_owner: string | null;
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
  private readonly listRunningStmt: Database.Statement;
  private readonly recoverRunningStmt: Database.Statement;
  private readonly markInterruptedStmt: Database.Statement;
  private readonly requeueRecurringStmt: Database.Statement;
  private readonly assignSessionStmt: Database.Statement;
  /**
   * Why this database has no `run_owner` column — the open that should
   * have added it could not (see `ensureRunOwnerColumn`) — or `null`.
   * Claims then record no owner, and the boot sweep falls back to age.
   */
  readonly runOwnersUnavailable: string | null;
  private readonly ownerProbe: TurnOwnerProbe;
  /** The database file's real path, as owners record it. */
  private readonly dbIdentity: string | undefined;

  constructor(options: TaskStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.runOwnersUnavailable = ensureRunOwnerColumn(this.db);
    const withOwners = this.runOwnersUnavailable === null;
    this.ownerProbe = options.ownerProbe ?? currentTurnOwnerProbe();
    this.dbIdentity = databaseIdentity(options.dbFile);

    this.insertStmt = this.db.prepare(
      `INSERT INTO tasks (
         id, session_id, user_message, max_steps, status, origin,
         attempts, max_attempts, last_error, last_error_cat,
         created_at, updated_at, started_at, completed_at,
         schedule_kind, schedule_value, scheduled_for, recurring,
         last_scheduled_at, trigger_source, notify
       ) VALUES (
         @id, @session_id, @user_message, @max_steps, @status, @origin,
         @attempts, @max_attempts, @last_error, @last_error_cat,
         @created_at, @updated_at, @started_at, @completed_at,
         @schedule_kind, @schedule_value, @scheduled_for, @recurring,
         @last_scheduled_at, @trigger_source, @notify
       )`,
    );
    this.selectStmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
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
    const claimOwner = withOwners ? ",\n              run_owner = @owner" : "";
    // The claim names its owner in the same write, with the claim's own
    // time as the owner's `at`: a row's owner speaks for the run only
    // while `at` equals `started_at`. An older binary sharing the file
    // claims without touching `run_owner`, so an owner left from an
    // earlier claim never matches that run's `started_at`.
    this.markRunningStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'running',
              attempts = attempts + 1,
              started_at = @now,
              updated_at = @now,
              last_error = NULL,
              last_error_cat = NULL${claimOwner}
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
    this.listRunningStmt = this.db.prepare(
      `SELECT id, started_at, ${withOwners ? "run_owner" : "NULL AS run_owner"}
         FROM tasks WHERE status = 'running'`,
    );
    // Keyed on the claim the sweep judged (`started_at`), so a row
    // claimed again in between is never taken back on the old verdict.
    this.recoverRunningStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              updated_at = @now,
              started_at = NULL,
              last_error = COALESCE(last_error, @last_error),
              last_error_cat = COALESCE(last_error_cat, 'transport')
        WHERE id = @id AND status = 'running' AND started_at IS @started_at`,
    );
    this.markInterruptedStmt = this.db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              attempts = CASE WHEN @scheduled_for IS NULL THEN attempts ELSE 0 END,
              started_at = NULL,
              scheduled_for = COALESCE(@scheduled_for, scheduled_for),
              last_scheduled_at = CASE
                WHEN @scheduled_for IS NULL THEN last_scheduled_at
                ELSE @now
              END,
              updated_at = @now,
              last_error = @last_error,
              last_error_cat = 'cancelled'
        WHERE id = @id AND status = 'running'`,
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
    const notify = validateNotify(input.notify);
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
      notify,
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
  listPending(
    options: { sessionId?: string; limit?: number } = {},
  ): TaskRecord[] {
    const limit = options.limit ?? 100;
    const rows = options.sessionId
      ? (this.listPendingBySessionStmt.all(
          options.sessionId,
          limit,
        ) as TaskRow[])
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
    const owner =
      this.runOwnersUnavailable === null
        ? serializeTurnOwner(
            turnOwnerFor(this.ownerProbe, now, this.dbIdentity),
          )
        : null;
    const result = this.markRunningStmt.run(
      owner === null ? { id, now } : { id, now, owner },
    ) as { changes: number };
    if (result.changes === 0) return null;
    return this.get(id);
  }

  markCompleted(id: string, now: number = Date.now()): TaskRecord {
    const result = this.markCompletedStmt.run({ id, now }) as {
      changes: number;
    };
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
   * Put a `running` task back to `pending` because its run was stopped
   * before it could end, rather than ending it: the agent quitting under
   * a scheduled turn, or that turn stopped from its chat. Nothing went
   * wrong with the task itself, so it is neither cancelled nor failed.
   *
   *  - `nextScheduledFor: null` — a one-shot task, left due as it was, so
   *    the next drain (the next start, when the agent is quitting) runs
   *    it. The attempt it was on still counts, as it would have after a
   *    crash.
   *  - a time — a recurring task, rearmed for its next firing with the
   *    per-firing bookkeeping reset, as `requeueRecurring` does after a
   *    firing that completed. Only that one firing is lost; the schedule
   *    goes on.
   *
   * Returns `null` when the row is no longer `running` — an operator
   * cancelled it meanwhile, and that stands.
   */
  markInterrupted(
    id: string,
    options: { nextScheduledFor: number | null },
    now: number = Date.now(),
  ): TaskRecord | null {
    const result = this.markInterruptedStmt.run({
      id,
      now,
      scheduled_for: options.nextScheduledFor,
      last_error: TASK_INTERRUPTED_ERROR,
    }) as { changes: number };
    if (result.changes === 0) return null;
    return this.get(id);
  }

  /**
   * The boot sweep: put back to `pending` every `running` task whose run
   * will never write its end, so the scheduler runs it again instead of
   * the row saying "running" for ever (a desktop drew one such task as
   * running, pulsing, for good).
   *
   * Judged by the run's owner, the way session turn marks are
   * (`isTurnOwnerGone`): a claim records which process made it, and
   * that process is gone when its pid is dead, belongs to a process that
   * started at another moment, or the host has rebooted since; an owner
   * written into another database file (a copy) is gone too, and one
   * from another pid namespace is never judged. A live owner keeps its
   * task, however long the run has taken — a second agent on the same
   * state dir (`serve` beside a TUI) is still running it.
   *
   * Age was the only rule before owners existed, and it missed the case
   * that mattered: an agent restarted seconds after it was stopped found
   * its own task "fresh" and left it `running` for good. It remains the
   * rule for a row whose owner says nothing about the run — claimed by a
   * binary that records no owner, or on a database without the column —
   * where `started_at` older than `staleAfterMs` is all there is to go on.
   *
   * Boot only, before this process has claimed a task: an owner carrying
   * this process's pid then names an earlier process with that number
   * (see `isTurnOwnerGone`). `isOwnerGone` is a test seam. One
   * `BEGIN IMMEDIATE` transaction, since it reads and then writes. Returns
   * the ids it put back.
   */
  recoverInterrupted(options: {
    staleAfterMs: number;
    now?: number;
    isOwnerGone?: (owner: string) => boolean;
  }): string[] {
    const now = options.now ?? Date.now();
    const probe = this.ownerProbe;
    const db = this.dbIdentity;
    const isOwnerGone =
      options.isOwnerGone ??
      ((owner: string) => isTurnOwnerGone(owner, probe, db));
    const sweep = this.db.transaction((): string[] => {
      const rows = this.listRunningStmt.all() as RunningRow[];
      const recovered: string[] = [];
      for (const row of rows) {
        const owner = parseTurnOwner(row.run_owner);
        const ownsThisRun =
          owner !== null &&
          row.started_at !== null &&
          owner.at === row.started_at;
        const gone = ownsThisRun
          ? isOwnerGone(row.run_owner as string)
          : row.started_at !== null &&
            row.started_at < now - options.staleAfterMs;
        if (!gone) continue;
        const result = this.recoverRunningStmt.run({
          id: row.id,
          now,
          started_at: row.started_at,
          last_error: ownsThisRun
            ? TASK_OWNER_GONE_ERROR
            : "recovered from stale running",
        }) as { changes: number };
        if (result.changes > 0) recovered.push(row.id);
      }
      return recovered;
    });
    return sweep.immediate();
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

/**
 * Give `tasks` its `run_owner` column: the process that claimed the row
 * for the run in progress (a `TurnOwner`, as JSON), which the boot sweep
 * judges. Outside the numbered migrations on purpose — a binary that
 * predates the column refuses a newer schema version, while an extra
 * nullable column it never names leaves it working as before. Two
 * processes can open the file at once; the one that loses the race to
 * add it finds it there.
 *
 * Adding it takes the write lock, which an open may not get in time, or
 * may not be allowed (a file this process may only read): the store then
 * runs without owners and the next open tries again. Returns why the
 * column is missing, or `null`.
 */
function ensureRunOwnerColumn(db: Database.Database): string | null {
  try {
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "run_owner")) return null;
    db.exec(`ALTER TABLE tasks ADD COLUMN run_owner TEXT`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return /duplicate column/i.test(message) ? null : message;
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
    notify: normalizeNotify(row.notify),
  };
}

/**
 * Clamp a persisted `notify` value to the allow-list. A row written
 * by a newer schema (or hand-edited) with an unknown target reads
 * back as `null` — the task simply stays silent instead of feeding
 * an unroutable target into the runner.
 */
function normalizeNotify(raw: string | null): TaskNotifyTarget | null {
  if (raw === null) return null;
  return (TASK_NOTIFY_TARGETS as readonly string[]).includes(raw)
    ? (raw as TaskNotifyTarget)
    : null;
}

function validateSessionId(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new TaskValidationError(
      "sessionId",
      "sessionId must be a string or null",
    );
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
    throw new TaskValidationError(
      "userMessage",
      "userMessage must be a string",
    );
  }
  if (raw.length === 0) {
    throw new TaskValidationError(
      "userMessage",
      "userMessage must be non-empty",
    );
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

function validateNotify(
  raw: TaskNotifyTarget | null | undefined,
): TaskNotifyTarget | null {
  if (raw === undefined || raw === null) return null;
  if (!(TASK_NOTIFY_TARGETS as readonly string[]).includes(raw)) {
    throw new TaskValidationError(
      "notify",
      `notify must be one of: ${TASK_NOTIFY_TARGETS.join(", ")}`,
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
