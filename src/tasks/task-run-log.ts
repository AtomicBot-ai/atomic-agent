import type Database from "better-sqlite3";

/**
 * How one run of a task ended (ATO-590), as the run log records it:
 *
 *  - `completed` / `failed` / `blocked` / `cancelled`: the task's own
 *    terminal transition (a recurring task's `completed` run is followed
 *    by its requeue, which the log does not count as a run).
 *  - `retry`: the run failed and the task went back to `pending` for
 *    another attempt.
 *  - `interrupted`: the run was stopped before it ended (shutdown, the
 *    turn stopped from outside, or the boot sweep took it back from a
 *    process that is gone).
 *  - `unknown`: the run was still open when the task was claimed again,
 *    i.e. something that does not write the log (an older binary on the
 *    same file) ended it.
 */
export type TaskRunOutcome =
  | "completed"
  | "failed"
  | "retry"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "unknown";

/** One row of the run log: one claim of a task, from start to end. */
export interface TaskRunRecord {
  id: number;
  taskId: string;
  /** The task's `attempts` after the claim that started this run. */
  attempt: number;
  /** The session the run used; filled in at the end for a lazy one-shot. */
  sessionId: string | null;
  startedAt: number;
  /** `null` while the run is going. */
  endedAt: number | null;
  /** `null` while the run is going. */
  outcome: TaskRunOutcome | null;
  error: string | null;
  errorCategory: string | null;
}

/** Runs kept per task; older ones are dropped when a new run starts. */
export const TASK_RUNS_KEPT_PER_TASK = 200;

interface RunRow {
  id: number;
  task_id: string;
  attempt: number;
  session_id: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  error: string | null;
  error_cat: string | null;
}

/**
 * The history of a task's runs, kept beside the queue in
 * `tasks.sqlite` (`task_runs`), one row per claim (ATO-590). The queue
 * row only holds the latest attempt; this is what lets a person see
 * every past firing of a schedule and how each one ended.
 *
 * The table is added outside the numbered migrations, as `run_owner`
 * is: a binary that predates it refuses a newer schema version, while
 * an extra table it never names leaves it working. When it cannot be
 * added (a file this process may only read, a lock not got in time) the
 * log is off for this open — every write is a no-op and every read is
 * empty — and the queue works as before.
 *
 * Written by `TaskStore` at each transition of a claimed row; never by
 * the runner, so every path that claims or ends a run is covered. A
 * write that fails is dropped (`quietly`): the history is best effort,
 * the queue is not.
 */
export class TaskRunLog {
  /** Why the log is off for this open, or `null`. */
  readonly unavailable: string | null;
  private readonly openStmt: Database.Statement | null = null;
  private readonly closeStmt: Database.Statement | null = null;
  private readonly pruneStmt: Database.Statement | null = null;
  private readonly listStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.unavailable = ensureRunLogTable(db);
    if (this.unavailable !== null) return;
    this.openStmt = db.prepare(
      `INSERT INTO task_runs (task_id, attempt, session_id, started_at)
       VALUES (@task_id, @attempt, @session_id, @now)`,
    );
    // Only an open run is closed, so a transition with no run behind it
    // (cancelling a pending row) writes nothing. The session is taken
    // from the task when the run started without one (lazy one-shot).
    this.closeStmt = db.prepare(
      `UPDATE task_runs
          SET ended_at = @now,
              outcome = @outcome,
              error = @error,
              error_cat = @error_cat,
              session_id = COALESCE(
                session_id,
                (SELECT session_id FROM tasks WHERE id = @task_id)
              )
        WHERE task_id = @task_id AND ended_at IS NULL`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM task_runs
        WHERE task_id = @task_id
          AND id NOT IN (
            SELECT id FROM task_runs WHERE task_id = @task_id
            ORDER BY id DESC LIMIT @keep
          )`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
    );
  }

  /**
   * A run started (the row was just claimed). A run of this task still
   * open is closed first as `unknown`: whatever ended it did not write
   * the log, and a task runs once at a time.
   */
  open(
    taskId: string,
    attempt: number,
    sessionId: string | null,
    now: number,
  ): void {
    if (!this.openStmt) return;
    const openStmt = this.openStmt;
    this.close(taskId, "unknown", null, now);
    quietly(() => {
      openStmt.run({ task_id: taskId, attempt, session_id: sessionId, now });
      this.pruneStmt?.run({ task_id: taskId, keep: TASK_RUNS_KEPT_PER_TASK });
    });
  }

  /** The task's open run ended this way. A no-op when no run is open. */
  close(
    taskId: string,
    outcome: TaskRunOutcome,
    failure: { message: string; category: string | null } | null,
    now: number,
  ): void {
    const closeStmt = this.closeStmt;
    if (!closeStmt) return;
    quietly(() =>
      closeStmt.run({
        task_id: taskId,
        now,
        outcome,
        error: failure?.message ?? null,
        error_cat: failure?.category ?? null,
      }),
    );
  }

  /** The task's runs, newest first. */
  list(taskId: string, limit = 50): TaskRunRecord[] {
    if (!this.listStmt) return [];
    const capped = Math.max(1, Math.min(limit, TASK_RUNS_KEPT_PER_TASK));
    const rows = this.listStmt.all(taskId, capped) as RunRow[];
    return rows.map(rowToRun);
  }
}

/**
 * Run a log write that must never fail the queue transition it follows:
 * the row has already moved (a claim made, a run ended), and a busy or
 * read-only file losing one history row beats the runner never hearing
 * of the move.
 */
function quietly(write: () => unknown): void {
  try {
    write();
  } catch {
    // The history misses this row; the queue is unaffected.
  }
}

function ensureRunLogTable(db: Database.Database): string | null {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL,
        attempt     INTEGER NOT NULL,
        session_id  TEXT,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        outcome     TEXT,
        error       TEXT,
        error_cat   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task
        ON task_runs(task_id, id);
    `);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function rowToRun(row: RunRow): TaskRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome as TaskRunOutcome | null,
    error: row.error,
    errorCategory: row.error_cat,
  };
}
