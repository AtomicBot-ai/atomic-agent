import { existsSync } from "node:fs";
import type BetterSqlite3 from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

/**
 * The working directories of the most recently updated sessions, newest
 * first, read straight from the `sessions` table without opening a
 * `SessionStore`.
 *
 * Meant for the moment before a runtime exists (the TUI deciding which
 * folder to open in), so it must not do any of the things a store open
 * does: no schema creation, no column migration, no WAL switch. The file
 * is opened read-only and closed again before returning. A missing file,
 * a missing table, a locked or corrupt database all read as "no history"
 * rather than an error: a launch must never fail on a convenience.
 */
export function readRecentWorkingDirs(dbFile: string, limit = 5): string[] {
  if (!existsSync(dbFile)) return [];
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new DatabaseCtor(dbFile, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT working_dir AS workingDir FROM sessions ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ workingDir: unknown }>;
    return rows
      .map((row) => row.workingDir)
      .filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* Closing a handle that failed to open: nothing to release. */
    }
  }
}
