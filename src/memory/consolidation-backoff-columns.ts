/**
 * ATO-2506. Two nullable columns on `memories` that let the consolidator
 * put off a cluster the model abstained from:
 *
 *   - `consolidation_abstains`  how many times in a row a cluster holding
 *                               this note came back "(no consensus)";
 *                               NULL = never.
 *   - `consolidation_retry_at`  wall-clock ms before which the note is not
 *                               a consolidation candidate; NULL = due now.
 *
 * Added in place, without a `MEMORY_SCHEMA_VERSION` bump, for the same
 * reason as `disabled_at` (see memory-schema.ts): an older binary sharing
 * the state dir keeps opening the file, names its own columns in every
 * statement and so never sees these. To it every note is simply due.
 */
export interface BackoffColumnsDb {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

const BACKOFF_COLUMNS: readonly { name: string; sql: string }[] = [
  {
    name: "consolidation_abstains",
    sql: `ALTER TABLE memories ADD COLUMN consolidation_abstains INTEGER`,
  },
  {
    name: "consolidation_retry_at",
    sql: `ALTER TABLE memories ADD COLUMN consolidation_retry_at INTEGER`,
  },
];

export function ensureConsolidationBackoffColumns(db: BackoffColumnsDb): void {
  for (const column of BACKOFF_COLUMNS) {
    const present = db
      .prepare(
        `SELECT 1 AS present FROM pragma_table_info('memories') WHERE name = ?`,
      )
      .get(column.name);
    if (present) continue;
    try {
      db.exec(column.sql);
    } catch (err) {
      // Another process sharing the file added it first.
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) {
        throw err;
      }
    }
  }
}
