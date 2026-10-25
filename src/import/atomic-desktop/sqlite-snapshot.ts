import { copyFileSync, existsSync } from "node:fs";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";

/**
 * Copy one SQLite database into `destFile` as of a single moment,
 * whatever its `-wal` still holds included, without writing the source.
 *
 * - No `-wal` beside it: the last connection closed cleanly and every
 *   page is in the main file, so a byte copy is the whole database.
 *   Copying rather than opening matters: SQLite opening a WAL-mode file
 *   (even read-only) creates an empty `-wal` and `-shm` next to it.
 * - A `-wal` beside it: a process may still hold it open (or one died
 *   with it open). The source is opened read-only and copied with
 *   SQLite's online backup, which reads through the WAL and restarts
 *   itself when another connection commits mid-copy, so the copy cannot
 *   be torn. A read-only connection never checkpoints, truncates or
 *   removes the `-wal`; only the `-shm` index is touched, as by any
 *   reader.
 *
 * The copy is a private file the caller owns and may migrate freely.
 */
export async function snapshotSqlite(
  sourceFile: string,
  destFile: string,
): Promise<void> {
  if (!existsSync(`${sourceFile}-wal`)) {
    copyFileSync(sourceFile, destFile);
    return;
  }
  const db = new DatabaseCtor(sourceFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await db.backup(destFile);
  } finally {
    db.close();
  }
}
