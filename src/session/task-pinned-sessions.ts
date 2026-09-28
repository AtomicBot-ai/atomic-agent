import { existsSync } from "node:fs";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

/**
 * Sessions a scheduled task points at, read out of `tasks.sqlite`.
 *
 * The task queue lives in its own file with no cross-file FK to
 * `sessions.sqlite` (SQLite has none), so nothing but this read stops
 * session retention from leaving a task pointing at a session that no
 * longer exists — `TaskRunner` then marks it `blocked` with
 * `session_not_found`, which is a scheduled job that silently stops
 * happening.
 *
 * Read-only and forgiving by design. A missing file, a missing `tasks`
 * table (a state dir whose queue was never touched) or a handle that
 * will not open skips the check rather than failing the caller: the
 * queue is optional (`tasks.enabled`) and the runtime has to boot either
 * way.
 */
export function readTaskPinnedSessionIds(
  tasksDbFile: string | null | undefined,
): string[] {
  if (!tasksDbFile || !existsSync(tasksDbFile)) return [];
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(tasksDbFile, {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare(
        `SELECT DISTINCT session_id AS id FROM tasks WHERE session_id IS NOT NULL`,
      )
      .all() as { id: unknown }[];
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do with a handle that will not close.
    }
  }
}
