/**
 * SQLite schema for the cross-session memory store. Lives in a file
 * separate from `sessions.sqlite` because durable facts and notes are
 * global — not tied to any particular session lifecycle.
 *
 * Two tables live here:
 *  - `profile_facts`  — key/value facts rendered into every prompt
 *    (v1; owned by `ProfileStore`).
 *  - `memories`       — freeform searchable notes accessed explicitly
 *    via agent tools (v2; owned by `MemoryStore`). Mirrored into an
 *    FTS5 virtual table `memories_fts` for BM25 keyword ranking.
 *
 * Schema evolution: bump `MEMORY_SCHEMA_VERSION` and extend
 * `applyMigrations` with a new step. The `schema_meta` table records the
 * version actually present on disk so upgrades are idempotent.
 */
export const MEMORY_SCHEMA_VERSION = 2 as const;

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

const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  source        TEXT NOT NULL,
  session_id    TEXT,
  working_dir   TEXT,
  tags          TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_working_dir
  ON memories(working_dir);
CREATE INDEX IF NOT EXISTS idx_memories_updated
  ON memories(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
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
  if (current > MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `memory.sqlite schema version ${current} is newer than the supported ${MEMORY_SCHEMA_VERSION}; refusing to downgrade`,
    );
  }
  if (current < 2) {
    db.exec(V2_SCHEMA);
  }
  if (current === MEMORY_SCHEMA_VERSION) return;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(MEMORY_SCHEMA_VERSION));
}
