import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import type { TaskReport } from "./task-report.js";

/**
 * Durable hold queue for task reports finished during quiet hours, so
 * a report held at 03:00 still goes out at 08:00 after a restart.
 *
 * A table of its own in `tasks.sqlite`, created with `IF NOT EXISTS` on
 * open rather than through `applyMigrations`: it carries no foreign key
 * to `tasks`, the report is a self-contained JSON snapshot, and keeping
 * it out of the versioned schema means it never collides with column
 * migrations of the task rows. Own connection on the same file (WAL).
 */
export interface HeldTaskReport {
  id: number;
  heldAt: number;
  report: TaskReport;
}

/** What the hold queue needs; the SQLite store below and test fakes. */
export interface HeldReportStore {
  /** Returns the task ids evicted to stay under `HELD_REPORTS_MAX`. */
  add(report: TaskReport, heldAt: number): readonly string[];
  /** Oldest first. */
  list(): HeldTaskReport[];
  remove(ids: readonly number[]): void;
}

/**
 * Held reports kept at most. Past it the oldest is dropped (and the
 * caller logs it): a channel that never comes back must not grow the
 * file without bound.
 */
export const HELD_REPORTS_MAX = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS held_task_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  held_at     INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
`;

export class SqliteHeldReportStore implements HeldReportStore {
  private readonly db: Database.Database;

  constructor(options: { dbFile: string }) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Returns the task ids evicted to stay under `HELD_REPORTS_MAX`. */
  add(report: TaskReport, heldAt: number): string[] {
    this.db
      .prepare(
        `INSERT INTO held_task_reports (task_id, held_at, report_json) VALUES (?, ?, ?)`,
      )
      .run(report.taskId, heldAt, JSON.stringify(report));
    const over = this.db
      .prepare(
        `SELECT id, task_id FROM held_task_reports ORDER BY id DESC LIMIT -1 OFFSET ?`,
      )
      .all(HELD_REPORTS_MAX) as Array<{ id: number; task_id: string }>;
    if (over.length > 0) this.remove(over.map((r) => r.id));
    return over.map((r) => r.task_id);
  }

  list(): HeldTaskReport[] {
    const rows = this.db
      .prepare(`SELECT id, held_at, report_json FROM held_task_reports ORDER BY id ASC`)
      .all() as Array<{ id: number; held_at: number; report_json: string }>;
    const out: HeldTaskReport[] = [];
    for (const row of rows) {
      try {
        out.push({ id: row.id, heldAt: row.held_at, report: JSON.parse(row.report_json) as TaskReport });
      } catch {
        // A row that no longer parses cannot be delivered; drop it
        // rather than block every later digest behind it.
        this.remove([row.id]);
      }
    }
    return out;
  }

  remove(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM held_task_reports WHERE id = ?`);
    this.db.transaction(() => {
      for (const id of ids) stmt.run(id);
    })();
  }

  close(): void {
    this.db.close();
  }
}
