/**
 * SQLite schema for the cross-session memory store. Lives in a file
 * separate from `sessions.sqlite` because profile facts are global —
 * they are not tied to any particular session lifecycle.
 *
 * Schema evolution: bump `MEMORY_SCHEMA_VERSION` and extend
 * `applyMigrations` with a new step. The `schema_meta` table records the
 * version actually present on disk so upgrades are idempotent.
 */
export const MEMORY_SCHEMA_VERSION = 1 as const;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_facts (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_facts_updated
  ON profile_facts(updated_at DESC);
`;

export interface MemoryDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export function applyMigrations(db: MemoryDatabaseLike): void {
  db.exec(BASE_SCHEMA);
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  const current = row ? Number.parseInt(row.value, 10) : 0;
  if (current === MEMORY_SCHEMA_VERSION) return;
  if (current > MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `memory.sqlite schema version ${current} is newer than the supported ${MEMORY_SCHEMA_VERSION}; refusing to downgrade`,
    );
  }
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(MEMORY_SCHEMA_VERSION));
}
