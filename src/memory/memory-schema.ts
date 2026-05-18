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
export const MEMORY_SCHEMA_VERSION = 8 as const;

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

// V3 extends `profile_facts` with contextual gating: `pinned` (1 by
// default) marks the fact as always-in-prompt, `keywords` is a JSON
// string[] that `profile-renderer` matches against the current user
// message to include otherwise-suppressed facts only when relevant.
//
// Rationale: pinning preserves back-compat (every existing row is
// implicitly "pinned=1"), while the keyword gate unlocks a path to much
// larger profiles without blowing up the per-turn token budget.
const V3_MIGRATION = `
ALTER TABLE profile_facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profile_facts ADD COLUMN keywords TEXT;
`;

// V4 introduces three new columns on `memories`, all defaulted so back-
// compat is trivial:
//   - `recall_count`     — bumped by `MemoryStore.recall` exactly once
//                          per turn, drives utility-weighted eviction so
//                          old-but-frequently-recalled rows survive.
//   - `last_recalled_at` — wall-clock ms; lets later phases reason about
//                          recency without dragging session-id joins.
//   - `consolidating_at` — wall-clock ms; the B↔C lease window used by
//                          phase 3 (`neighbor-evolver`) and phase 5
//                          (`ConsolidatorJob`) to avoid clobbering each
//                          other's writes (see MEMORY_FABRIC_V2.md
//                          §12.1).
//
// Phase 1A only uses `recall_count`; `last_recalled_at` and
// `consolidating_at` land dormant and are populated by later phases.
// Migration is idempotent: re-running this on a v4 database is a no-op
// because the `current < 4` guard already short-circuits.
const V4_MIGRATION = `
ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recalled_at INTEGER;
ALTER TABLE memories ADD COLUMN consolidating_at INTEGER;
`;

// V5 introduces the `memory_embeddings` table. One row per (memory_id,
// model) pair so a single corpus can host multiple embedding model
// versions side-by-side during a migration / A/B rollout — the
// in-flight `HybridRecall` reads only rows where `model` matches the
// currently-configured embedding model.
//
// Storage: `embedding BLOB` holds Float32 little-endian (`dim * 4`
// bytes). No `sqlite-vec` virtual table yet — JS-side brute-force
// cosine handles up to ~`memory.embeddings.bruteForceCeiling` rows
// (default 200, see `memory-store-v2.embeddings.test.ts`). Above that
// the recall layer emits `agent.memory.embeddings.brute_force_overflow`
// and falls back to FTS5-only until either (a) the corpus is trimmed
// or (b) `sqlite-vec` is wired in (deferred phase 1B follow-up).
//
// Cascade: `ON DELETE CASCADE` so memory removal in `MemoryStore`
// cleans embeddings without a separate transaction. The composite PK
// `(memory_id, model)` lets us keep multi-model rows without
// auto-incrementing junk ids.
const V5_MIGRATION = `
CREATE TABLE memory_embeddings (
  memory_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_embeddings_model ON memory_embeddings(model);
`;

// V6 introduces the `memory_links` table — the reactive graph layer
// (memory-v2 phase 2, Path B-half-1).
//
// Shape:
//   - `from_id` / `to_id` are both FKs into `memories(id)` with
//     `ON DELETE CASCADE` so a removed memory automatically drops
//     every edge touching it. No more orphan links.
//   - `kind` is a short uppercase tag (e.g. `RELATES_TO`,
//     `CAUSED_BY`, `REFERENCES`, `CONTRADICTS`). The composite PK
//     `(from_id, to_id, kind)` allows multiple link kinds between
//     the same pair (a note can both "RELATES_TO" and
//     "CONTRADICTS" another note).
//   - `weight` is a float in [0, 1] mainly used as a tiebreaker
//     during BFS expansion ordering. Default 1.0 — the LLM-driven
//     `link-generator` does not currently emit explicit weights.
//   - Self-loops (`from_id == to_id`) are rejected at insert time
//     (in `LinkStore.add`) — they add zero recall signal and break
//     BFS termination guarantees.
//
// Indexes: both `from_id` and `to_id` so BFS can walk in either
// direction in O(deg) time. The composite PK already covers
// `from_id` lookups, but we add an explicit `idx_memory_links_to`
// because SQLite cannot use the PK suffix for the reverse direction.
const V6_MIGRATION = `
CREATE TABLE memory_links (
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_links_to ON memory_links(to_id);
CREATE INDEX idx_memory_links_kind ON memory_links(kind);
`;

// V7 rebuilds `profile_facts` as a bi-temporal versioned table —
// memory-v2 phase 4 (Path B-half-3). The pre-v7 shape was a flat
// `(key PRIMARY KEY, value, pinned, keywords, updated_at)` UPSERT
// surface that overwrote history on every write. V7 introduces:
//
//   - `id INTEGER PK` so the chain has stable row identity.
//   - `valid_from`     when the row started being authoritative.
//   - `superseded_by`  pointer to the row that replaced this one;
//                      NULL for the active row of a key. Treated as
//                      a *soft* self-pointer (no FK constraint) so
//                      a manual `remove()` of an active row leaves
//                      the historical chain intact without dangling
//                      cascade rules.
//   - `supersedes`     reverse pointer to the row this one replaces
//                      (also soft). Useful for `history(key)` walks
//                      that start from the active row.
//   - `created_at`     audit timestamp; copied from `valid_from` on
//                      a fresh row, preserved unchanged when an
//                      `updated_at` bump happens (today there is no
//                      such bump — every write is a new row — but
//                      the column gives phase 7a a place to hang
//                      vote scores without another migration).
//
// Active-row uniqueness is enforced by the **partial unique index**
// `idx_profile_active_key ON profile_facts(key) WHERE superseded_by
// IS NULL` — two NULL `superseded_by`s for the same key are rejected
// at insert time, which is the storage-layer guard for cross-phase
// invariant 6 in MEMORY_FABRIC_V2.md §13.7.7.
//
// Legacy migration:
//
//   - The pre-v7 `profile_facts` table is renamed to
//     `profile_facts_legacy`.
//   - For every legacy row we insert exactly one v7 row with
//     `valid_from = legacy.updated_at`, `created_at = legacy.updated_at`,
//     `superseded_by = NULL`, `supersedes = NULL`.
//   - `pinned` defaults to `1` for legacy rows that predate v3
//     (the v3 ALTER added the column with `DEFAULT 1`, so this is
//     a no-op for v3+ files; we keep the COALESCE to be safe).
//   - The legacy table is dropped at the end of the migration so
//     subsequent boots do not race against it.
//
// The migration is idempotent because `applyMigrations` short-circuits
// when the version row already says 7.
const V7_MIGRATION = `
ALTER TABLE profile_facts RENAME TO profile_facts_legacy;
CREATE TABLE profile_facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 1,
  keywords        TEXT,
  valid_from      INTEGER NOT NULL,
  superseded_by   INTEGER,
  supersedes      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_profile_active_key
  ON profile_facts(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_profile_chain ON profile_facts(superseded_by);
INSERT INTO profile_facts
  (key, value, pinned, keywords, valid_from, superseded_by, supersedes,
   created_at, updated_at)
  SELECT key,
         value,
         COALESCE(pinned, 1),
         keywords,
         updated_at,
         NULL,
         NULL,
         updated_at,
         updated_at
    FROM profile_facts_legacy;
DROP TABLE profile_facts_legacy;
`;

// V8 introduces the **lessons** table — memory-v2 phase 5 (Path C-half).
// A lesson is a distilled summary of N related episodes (NOTEs) that
// the cold-path consolidator promotes into a compact pointer view
// (`### lessons` in the prompt tail). The original episodes are
// archived (`consolidated_into = <lessonId>`) but **never deleted** —
// `memory.notes.recall { id }` of an archived row still returns the
// original `MemoryEntry`, preserving audit/trace integrity (this is
// cross-phase invariant 9 in MEMORY_FABRIC_V2.md §9).
//
// Shape highlights:
//   - `activation` and `principle` are the two LLM-distilled fields;
//     they get indexed in `lessons_fts` for BM25 recall on the user
//     message. `activation` is the one-sentence "when this lesson
//     applies" hook; `principle` is the 1–3 sentence durable
//     observation.
//   - `parent_ids` is a JSON array of the episode ids that were
//     consolidated into this lesson. Mandatory so a deprecation /
//     audit pass can walk back from a lesson to its parents.
//   - `status` is `'active' | 'deprecated'`. Deprecated lessons stay
//     on disk and are still recallable by id, but drop out of the
//     hot `### lessons` index. Phase 6 owns the deprecation logic;
//     phase 5 only ships the column shape.
//   - `success_count` / `failure_count` are phase-6 lifecycle
//     signals. Always zero on creation in phase 5.
//   - `working_dir` mirrors the episode-level scope so per-project
//     lessons can be filtered later (phase 7a `scope` filtering).
//
// `consolidated_into` on `memories` is the back-pointer added in this
// same migration. The index supports two hot lookups:
//   1. "Is this episode archived?" (used by the renderer / context
//      provider to exclude archived rows from `### memory-index`).
//   2. "What are the parents of this lesson?" (used by the
//      consolidator's link-rewire pass).
//
// `lessons_fts` is an FTS5 contentless table (`content='lessons'`)
// with the same triggers pattern as `memories_fts` (insert / delete /
// update). All three triggers fire on `lessons` mutations.
//
// **KV-cache invalidation note.** Phase 5 also adds a `### lessons`
// mention to the persona stable prefix in [src/prompt/persona.ts].
// That is the first of two planned one-time main-slot KV-cache
// invalidations for memory-v2 (the second lands with phase 7b's
// `### procedures`). The schema migration itself never touches the
// stable prefix, so no cache flush is triggered by the SQL above.
const V8_MIGRATION = `
ALTER TABLE memories ADD COLUMN consolidated_into INTEGER;
CREATE INDEX idx_memories_consolidated ON memories(consolidated_into);

CREATE TABLE lessons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  activation      TEXT NOT NULL,
  principle       TEXT NOT NULL,
  tags            TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  success_count   INTEGER NOT NULL DEFAULT 0,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  parent_ids      TEXT NOT NULL,
  working_dir     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deprecated_at   INTEGER
);
CREATE INDEX idx_lessons_status ON lessons(status);
CREATE INDEX idx_lessons_updated_at ON lessons(updated_at);

CREATE VIRTUAL TABLE lessons_fts USING fts5(
  activation, principle, tags,
  content='lessons',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, activation, principle, tags)
    VALUES (new.id, new.activation, new.principle, COALESCE(new.tags, ''));
END;
CREATE TRIGGER lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, activation, principle, tags)
    VALUES ('delete', old.id, old.activation, old.principle, COALESCE(old.tags, ''));
END;
CREATE TRIGGER lessons_au AFTER UPDATE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, activation, principle, tags)
    VALUES ('delete', old.id, old.activation, old.principle, COALESCE(old.tags, ''));
  INSERT INTO lessons_fts(rowid, activation, principle, tags)
    VALUES (new.id, new.activation, new.principle, COALESCE(new.tags, ''));
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
  if (current < 3) {
    db.exec(V3_MIGRATION);
  }
  if (current < 4) {
    db.exec(V4_MIGRATION);
  }
  if (current < 5) {
    db.exec(V5_MIGRATION);
  }
  if (current < 6) {
    db.exec(V6_MIGRATION);
  }
  if (current < 7) {
    db.exec(V7_MIGRATION);
  }
  if (current < 8) {
    db.exec(V8_MIGRATION);
  }
  if (current === MEMORY_SCHEMA_VERSION) return;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(MEMORY_SCHEMA_VERSION));
}
