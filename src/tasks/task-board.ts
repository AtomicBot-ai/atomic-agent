import type Database from "better-sqlite3";

import { isBoardLane, type BoardEntry, type BoardPatch } from "./task-board-lanes.js";

interface BoardRow {
  task_id: string;
  lane: string | null;
  lane_set_at: number | null;
  note: string | null;
  assignee: string | null;
  updated_at: number;
}

/**
 * What the task board keeps per task (ATO-2257): the lane a card was
 * put in, a note and an assignee (an agent profile name). Kept beside
 * the queue in `tasks.sqlite` (`task_board`), one row per task that has
 * any of these; a task with no row shows in the lane its status gives.
 *
 * The table is added outside the numbered migrations, as `task_runs`
 * and `run_owner` are: a binary that predates it refuses a newer schema
 * version, while an extra table it never names leaves it working. When
 * it cannot be added (a read-only file, a lock not got in time) the
 * board is off for this open: reads are empty, `set` answers `null`,
 * and the queue works as before. The board never changes a task's
 * status; it is a view over the queue.
 */
export class TaskBoard {
  /** Why the board is off for this open, or `null`. */
  readonly unavailable: string | null;
  private readonly getStmt: Database.Statement | null = null;
  private readonly allStmt: Database.Statement | null = null;
  private readonly upsertStmt: Database.Statement | null = null;
  private readonly deleteStmt: Database.Statement | null = null;
  private readonly pruneStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.unavailable = ensureBoardTable(db);
    if (this.unavailable !== null) return;
    this.getStmt = db.prepare(`SELECT * FROM task_board WHERE task_id = ?`);
    this.allStmt = db.prepare(`SELECT * FROM task_board`);
    this.upsertStmt = db.prepare(
      `INSERT INTO task_board (task_id, lane, lane_set_at, note, assignee, updated_at)
       VALUES (@task_id, @lane, @lane_set_at, @note, @assignee, @now)
       ON CONFLICT(task_id) DO UPDATE SET
         lane = excluded.lane,
         lane_set_at = excluded.lane_set_at,
         note = excluded.note,
         assignee = excluded.assignee,
         updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM task_board WHERE task_id = ?`);
    this.pruneStmt = db.prepare(
      `DELETE FROM task_board WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );
  }

  get(taskId: string): BoardEntry | null {
    if (!this.getStmt) return null;
    const row = this.getStmt.get(taskId) as BoardRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Every stored entry, keyed by task id. */
  all(): Map<string, BoardEntry> {
    const entries = new Map<string, BoardEntry>();
    if (!this.allStmt) return entries;
    for (const row of this.allStmt.all() as BoardRow[]) {
      const entry = rowToEntry(row);
      entries.set(entry.taskId, entry);
    }
    return entries;
  }

  /**
   * Apply a checked patch (see `validateBoardPatch`) to the task's entry.
   * A field the patch leaves `undefined` keeps its stored value; setting
   * `lane` stamps `laneSetAt` with `now`. An entry left with nothing in
   * it is deleted. Returns the entry after the write (`null` when it is
   * empty or the board is off). The caller checks the task exists.
   */
  set(taskId: string, patch: BoardPatch, now: number): BoardEntry | null {
    if (!this.upsertStmt || !this.deleteStmt) return null;
    const before = this.get(taskId);
    const laneChanged = patch.lane !== undefined;
    const next = {
      task_id: taskId,
      lane: laneChanged ? patch.lane ?? null : before?.lane ?? null,
      lane_set_at: laneChanged
        ? patch.lane === null
          ? null
          : now
        : before?.laneSetAt ?? null,
      note: patch.note !== undefined ? patch.note : before?.note ?? null,
      assignee: patch.assignee !== undefined ? patch.assignee : before?.assignee ?? null,
      now,
    };
    if (next.lane === null && next.note === null && next.assignee === null) {
      this.deleteStmt.run(taskId);
      return null;
    }
    this.upsertStmt.run(next);
    return this.get(taskId);
  }

  /**
   * Drop entries whose task is gone (an incognito chat's tasks deleted,
   * ATO-586), so no note about them stays in the file. Best effort.
   */
  pruneOrphans(): void {
    const prune = this.pruneStmt;
    if (!prune) return;
    try {
      prune.run();
    } catch {
      // A busy file keeps the orphan rows until the next prune; cards
      // are only built for tasks that exist, so nothing shows them.
    }
  }
}

function ensureBoardTable(db: Database.Database): string | null {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_board (
        task_id     TEXT PRIMARY KEY,
        lane        TEXT,
        lane_set_at INTEGER,
        note        TEXT,
        assignee    TEXT,
        updated_at  INTEGER NOT NULL
      );
    `);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function rowToEntry(row: BoardRow): BoardEntry {
  return {
    taskId: row.task_id,
    // A lane this binary does not know (a newer one wrote it) reads as unset.
    lane: isBoardLane(row.lane) ? row.lane : null,
    laneSetAt: row.lane_set_at,
    note: row.note,
    assignee: row.assignee,
    updatedAt: row.updated_at,
  };
}
