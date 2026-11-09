import type Database from "better-sqlite3";

/**
 * How far a running turn has got, written beside the session row so a
 * turn cut off by a crash, a kill or a restart can be continued rather
 * than started over (ATO-1109).
 *
 * A turn used to reach the store once, at its end (`finishTurn`): every
 * step it had taken lived only in memory, so a process that died after
 * step 40 of a long task left a row that said nothing had happened. Now
 * `executeTurn` writes this marker when the turn starts and, with the
 * transcript, after every completed step (`SessionStore.checkpointTurn`).
 *
 * Stored as JSON in the `turn_progress` column, never in the payload,
 * for the reason `TurnOwner` gives: a `save` from a copy taken before
 * the turn would drop a marker that rode in the payload.
 *
 * Lifetime: a turn that ends on its own (reply, finish, failure, step
 * ceiling) clears it. A turn that ends `cancelled` keeps it, and so does
 * one whose process died (the boot sweep ends its row but leaves this):
 * those are the turns someone may want to continue. Who continues one is
 * the caller's decision; the durable task runner does it for tasks
 * stopped by a crash or a restart, never for one a person stopped.
 */
export interface TurnProgress {
  /** Steps completed and checkpointed so far in this turn. */
  readonly stepsDone: number;
  /** Index of the last completed step; -1 before the first one. */
  readonly lastStepIndex: number;
  /** The request the turn was started with (before any resume note). */
  readonly request: string;
  /** What the caller started the turn with, to start it again the same way. */
  readonly options: TurnResumeOptions;
  /**
   * How many times this piece of work has already been resumed after an
   * interruption. Carried from the interrupted turn into the turn that
   * continues it, so a task that crashes the agent every time is caught
   * (`agent.task.maxResumes`).
   */
  readonly resumes: number;
  /** When the turn started, ms since the epoch. */
  readonly startedAt: number;
  /** When this marker was last written, ms since the epoch. */
  readonly updatedAt: number;
}

/** The turn options a continuation needs to run the turn the same way. */
export interface TurnResumeOptions {
  /** The durable task the turn ran for, when it was one. */
  readonly taskId?: string;
  readonly maxSteps?: number;
  readonly taskMaxDurationMs?: number;
  readonly providerId?: string;
  readonly interactive?: boolean;
}

/** The stored form of a marker. */
export function serializeTurnProgress(progress: TurnProgress): string {
  return JSON.stringify({
    v: 1,
    stepsDone: progress.stepsDone,
    lastStepIndex: progress.lastStepIndex,
    request: progress.request,
    options: progress.options,
    resumes: progress.resumes,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
  });
}

const count = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= fallback
    ? value
    : fallback;

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

function parseOptions(raw: unknown): TurnResumeOptions {
  if (typeof raw !== "object" || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const maxSteps = positive(o.maxSteps);
  const taskMaxDurationMs = positive(o.taskMaxDurationMs);
  return {
    ...(typeof o.taskId === "string" && o.taskId.length > 0
      ? { taskId: o.taskId }
      : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(taskMaxDurationMs !== undefined ? { taskMaxDurationMs } : {}),
    ...(typeof o.providerId === "string" && o.providerId.length > 0
      ? { providerId: o.providerId }
      : {}),
    ...(o.interactive === true ? { interactive: true } : {}),
  };
}

/** A stored marker, or `null` when there is none or it does not parse. */
export function parseTurnProgress(raw: string | null): TurnProgress | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const f = value as Record<string, unknown>;
  if (typeof f.request !== "string") return null;
  return {
    stepsDone: count(f.stepsDone, 0),
    lastStepIndex: count(f.lastStepIndex, -1),
    request: f.request,
    options: parseOptions(f.options),
    resumes: count(f.resumes, 0),
    startedAt: count(f.startedAt, 0),
    updatedAt: count(f.updatedAt, 0),
  };
}

/** The statements `SessionStore` uses for markers. */
export interface TurnProgressStatements {
  /** Set (or clear, with `null`) the marker of a row this process owns. */
  readonly set: Database.Statement;
  /** Payload and marker of a row this process owns: one step's checkpoint. */
  readonly checkpoint: Database.Statement;
  readonly read: Database.Statement;
  readonly clear: Database.Statement;
}

/**
 * Prepare the marker statements; only once `ensureTurnProgressColumn`
 * has found or added the column. Every write is guarded on the turn's own mark (`turn_owner`), so a
 * turn another process has since started on the row is never written
 * over by a late step of this one.
 */
export function prepareTurnProgressStatements(
  db: Database.Database,
): TurnProgressStatements {
  return {
    set: db.prepare(
      `UPDATE sessions SET turn_progress = @progress
       WHERE id = @id AND turn_owner IS @owner`,
    ),
    // One row write per step: the transcript as it stands and the
    // marker, nothing else. The status column stays the turn's
    // `running`; `updated_at` moves because the content did.
    checkpoint: db.prepare(
      `UPDATE sessions
       SET payload = @payload,
           updated_at = @updated_at,
           turn_progress = @progress
       WHERE id = @id AND turn_owner IS @owner`,
    ),
    read: db.prepare(`SELECT turn_progress AS progress FROM sessions WHERE id = ?`),
    clear: db.prepare(`UPDATE sessions SET turn_progress = NULL WHERE id = ?`),
  };
}

/**
 * Give a `sessions` table made before markers existed its
 * `turn_progress` column: additive and nullable, so every existing row
 * reads as "no turn in progress" and an older binary sharing the file is
 * unaffected. A failure (another process holding the write lock past the
 * busy timeout, a read-only file) does not stop the store opening: it
 * runs without checkpoints and the next open tries again. Returns why
 * the column is missing, or `null`.
 */
export function ensureTurnProgressColumn(db: Database.Database): string | null {
  try {
    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "turn_progress")) return null;
    db.exec(`ALTER TABLE sessions ADD COLUMN turn_progress TEXT`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return /duplicate column/i.test(message) ? null : message;
  }
}
