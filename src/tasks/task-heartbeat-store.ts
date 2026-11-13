import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import type { HeartbeatConfig, HeartbeatOutcome, HeartbeatState } from "./task-heartbeat.js";
import { parseQuietHours } from "./task-report-quiet-hours.js";

/**
 * Durable heartbeat settings (ATO-454), one row per heartbeat task.
 *
 * A table of its own in `tasks.sqlite`, created with `IF NOT EXISTS` on
 * open like `held_task_reports`, rather than columns on `tasks`: the
 * task row stays an ordinary recurring `interval` task, and the
 * versioned schema of the task rows is left alone. Own connection on the
 * same file (WAL).
 */
export interface HeartbeatStore {
  get(taskId: string): HeartbeatConfig | null;
  recordOutcome(taskId: string, outcome: HeartbeatOutcome, at: number): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_heartbeats (
  task_id          TEXT PRIMARY KEY,
  checklist_path   TEXT NOT NULL,
  active_hours     TEXT,
  os_notify        INTEGER NOT NULL DEFAULT 0,
  last_outcome     TEXT,
  last_checked_at  INTEGER,
  created_at       INTEGER NOT NULL
);
`;

const OUTCOMES: readonly HeartbeatOutcome[] = [
  "nothing_new",
  "delivered",
  "outside_active_hours",
  "no_checklist",
];

interface HeartbeatRow {
  task_id: string;
  checklist_path: string;
  active_hours: string | null;
  os_notify: number;
  last_outcome: string | null;
  last_checked_at: number | null;
}

export class SqliteHeartbeatStore implements HeartbeatStore {
  private readonly db: Database.Database;

  constructor(options: { dbFile: string }) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  put(config: HeartbeatConfig, now: number = Date.now()): void {
    const activeHours = config.activeHours
      ? `${config.activeHours.start}-${config.activeHours.end}`
      : null;
    this.db
      .prepare(
        `INSERT INTO task_heartbeats (task_id, checklist_path, active_hours, os_notify, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           checklist_path = excluded.checklist_path,
           active_hours = excluded.active_hours,
           os_notify = excluded.os_notify`,
      )
      .run(config.taskId, config.checklistPath, activeHours, config.osNotify ? 1 : 0, now);
  }

  get(taskId: string): HeartbeatConfig | null {
    const state = this.state(taskId);
    if (state === null) return null;
    return {
      taskId: state.taskId,
      checklistPath: state.checklistPath,
      activeHours: state.activeHours,
      osNotify: state.osNotify,
    };
  }

  state(taskId: string): HeartbeatState | null {
    const row = this.db
      .prepare(`SELECT * FROM task_heartbeats WHERE task_id = ?`)
      .get(taskId) as HeartbeatRow | undefined;
    return row ? rowToState(row) : null;
  }

  list(): HeartbeatState[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_heartbeats ORDER BY created_at ASC`)
      .all() as HeartbeatRow[];
    return rows.map(rowToState);
  }

  recordOutcome(taskId: string, outcome: HeartbeatOutcome, at: number): void {
    this.db
      .prepare(
        `UPDATE task_heartbeats SET last_outcome = ?, last_checked_at = ? WHERE task_id = ?`,
      )
      .run(outcome, at, taskId);
  }

  remove(taskId: string): void {
    this.db.prepare(`DELETE FROM task_heartbeats WHERE task_id = ?`).run(taskId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * A `HeartbeatStore` that opens the file for each call and closes it
 * again. The runner asks it only about recurring `interval` tasks, at
 * most once per run, so the open costs nothing that matters, and no
 * connection stays open for the life of the process (a test's temp dir
 * can be removed on Windows; a read-only file just answers "no
 * heartbeat").
 */
export function openPerCallHeartbeatStore(dbFile: string): HeartbeatStore {
  const withStore = <T>(fn: (store: SqliteHeartbeatStore) => T): T => {
    const store = new SqliteHeartbeatStore({ dbFile });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  return {
    get: (taskId) => withStore((store) => store.get(taskId)),
    recordOutcome: (taskId, outcome, at) =>
      withStore((store) => store.recordOutcome(taskId, outcome, at)),
  };
}

function rowToState(row: HeartbeatRow): HeartbeatState {
  return {
    taskId: row.task_id,
    checklistPath: row.checklist_path,
    // A window that no longer parses runs the heartbeat around the clock
    // rather than never.
    activeHours: row.active_hours ? parseQuietHours(row.active_hours) : null,
    osNotify: row.os_notify === 1,
    lastOutcome: (OUTCOMES as readonly string[]).includes(row.last_outcome ?? "")
      ? (row.last_outcome as HeartbeatOutcome)
      : null,
    lastCheckedAt: row.last_checked_at,
  };
}
