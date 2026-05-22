import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, MEMORY_SCHEMA_VERSION } from "./memory-schema.js";

describe("applyMigrations", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mem-"));
    db = new DatabaseCtor(join(tmp, "memory.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the schema on an empty database", () => {
    applyMigrations(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("profile_facts");
    expect(names).toContain("schema_meta");
    expect(names).toContain("memories");
  });

  it("creates the memories_fts virtual table with sync triggers", () => {
    applyMigrations(db);
    const objects = db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE name LIKE 'memories_%' OR name LIKE 'memories' ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;
    const names = objects.map((o) => o.name);
    expect(names).toContain("memories_fts");
    expect(names).toContain("memories_ai");
    expect(names).toContain("memories_ad");
    expect(names).toContain("memories_au");
  });

  it("is idempotent across repeated runs", () => {
    applyMigrations(db);
    applyMigrations(db);
    const version = (
      db
        .prepare(`SELECT value FROM schema_meta WHERE key='version'`)
        .get() as { value: string }
    ).value;
    expect(Number.parseInt(version, 10)).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("migrates a v1 database to v2 on next open", () => {
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', '1');
      INSERT INTO profile_facts (key, value, updated_at) VALUES ('language', 'ru', 1000);
    `);
    applyMigrations(db);
    const version = (
      db
        .prepare(`SELECT value FROM schema_meta WHERE key='version'`)
        .get() as { value: string }
    ).value;
    expect(Number.parseInt(version, 10)).toBe(MEMORY_SCHEMA_VERSION);
    const fact = db
      .prepare(`SELECT value FROM profile_facts WHERE key='language'`)
      .get() as { value: string };
    expect(fact.value).toBe("ru");
    const memoryTables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name IN ('memories', 'memories_fts')`,
      )
      .all() as Array<{ name: string }>;
    expect(memoryTables.map((t) => t.name).sort()).toEqual([
      "memories",
      "memories_fts",
    ]);
  });

  it("adds pinned and keywords columns to profile_facts (v3)", () => {
    applyMigrations(db);
    const columns = db
      .prepare(`PRAGMA table_info(profile_facts)`)
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("pinned");
    expect(names).toContain("keywords");
  });

  it("migrates a v2 database to v3 and defaults existing rows to pinned=1", () => {
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        working_dir TEXT,
        tags TEXT
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', '2');
      INSERT INTO profile_facts (key, value, updated_at)
      VALUES ('language', 'ru', 1000);
    `);
    applyMigrations(db);
    const row = db
      .prepare(
        `SELECT value, pinned, keywords FROM profile_facts WHERE key='language'`,
      )
      .get() as { value: string; pinned: number; keywords: string | null };
    expect(row.value).toBe("ru");
    expect(row.pinned).toBe(1);
    expect(row.keywords).toBeNull();
  });

  it("adds recall_count, last_recalled_at, consolidating_at columns to memories (v4)", () => {
    applyMigrations(db);
    const columns = db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const byName = new Map(columns.map((c) => [c.name, c.dflt_value]));
    expect(byName.has("recall_count")).toBe(true);
    expect(byName.has("last_recalled_at")).toBe(true);
    expect(byName.has("consolidating_at")).toBe(true);
    // recall_count is NOT NULL DEFAULT 0; the others are nullable.
    expect(byName.get("recall_count")).toBe("0");
  });

  it("migrates a v3 database to v4 and preserves existing rows with recall_count=0", () => {
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        keywords TEXT
      );
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        working_dir TEXT,
        tags TEXT
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', '3');
      INSERT INTO memories (content, created_at, updated_at, source)
      VALUES ('legacy row', 1000, 1000, 'agent');
    `);
    applyMigrations(db);
    const row = db
      .prepare(
        `SELECT content, recall_count, last_recalled_at, consolidating_at FROM memories WHERE content='legacy row'`,
      )
      .get() as {
      content: string;
      recall_count: number;
      last_recalled_at: number | null;
      consolidating_at: number | null;
    };
    expect(row.content).toBe("legacy row");
    expect(row.recall_count).toBe(0);
    expect(row.last_recalled_at).toBeNull();
    expect(row.consolidating_at).toBeNull();
  });

  it("creates memory_embeddings table on v5 with FK to memories(id) ON DELETE CASCADE", () => {
    applyMigrations(db);
    type ColumnRow = {
      name: string;
      type: string;
      notnull: number;
    };
    const cols = db
      .prepare("PRAGMA table_info(memory_embeddings)")
      .all() as ColumnRow[];
    const byName = new Map(cols.map((c) => [c.name, c] as const));
    expect(byName.has("memory_id")).toBe(true);
    expect(byName.has("model")).toBe(true);
    expect(byName.has("dim")).toBe(true);
    expect(byName.has("embedding")).toBe(true);
    expect(byName.has("created_at")).toBe(true);
    expect(byName.get("dim")!.notnull).toBe(1);
    expect(byName.get("embedding")!.type.toUpperCase()).toBe("BLOB");

    // Composite primary key.
    type PkRow = { name: string; pk: number };
    const pks = (cols as unknown as PkRow[]).filter((c) => c.pk > 0);
    const pkNames = pks.sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pkNames).toEqual(["memory_id", "model"]);

    // FK exists and cascades.
    type FkRow = { from: string; table: string; to: string; on_delete: string };
    const fks = db
      .prepare("PRAGMA foreign_key_list(memory_embeddings)")
      .all() as FkRow[];
    expect(fks).toHaveLength(1);
    expect(fks[0]!.table).toBe("memories");
    expect(fks[0]!.from).toBe("memory_id");
    expect(fks[0]!.to).toBe("id");
    expect(fks[0]!.on_delete).toBe("CASCADE");
  });

  it("migrates a v4 database to v5 idempotently (memory_embeddings is empty + ready)", () => {
    // Bootstrap to v4 by setting the schema_meta marker manually.
    db.exec(`
      CREATE TABLE profile_facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        keywords TEXT
      );
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        working_dir TEXT,
        tags TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        consolidating_at INTEGER
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content);
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('version', '4');
    `);
    db.prepare(
      "INSERT INTO memories (content, created_at, updated_at, source) VALUES (?, 1, 1, 'agent')",
    ).run("legacy v4 row");
    applyMigrations(db);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM memory_embeddings")
      .get() as { c: number };
    expect(count.c).toBe(0);
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as {
        value: string;
      }
    ).value;
    expect(Number(version)).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("creates memory_links table on v6 with composite PK + dual FK cascade", () => {
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(memory_links)")
      .all() as Array<{ name: string; pk: number; notnull: number }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual([
      "from_id",
      "to_id",
      "kind",
      "weight",
      "created_at",
    ]);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(["from_id", "kind", "to_id"]);
    const fks = db
      .prepare("PRAGMA foreign_key_list(memory_links)")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(fks.length).toBe(2);
    for (const fk of fks) {
      expect(fk.table).toBe("memories");
      expect(fk.on_delete).toBe("CASCADE");
    }
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_links' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_memory_links_to");
    expect(indexNames).toContain("idx_memory_links_kind");
  });

  it("memory_links FK cascade fires when a memory is deleted", () => {
    applyMigrations(db);
    db.pragma("foreign_keys = ON");
    const insertMem = db.prepare(
      "INSERT INTO memories (content, created_at, updated_at, source) VALUES (?, 1, 1, 'agent') RETURNING id",
    );
    const a = (insertMem.get("note A") as { id: number }).id;
    const b = (insertMem.get("note B") as { id: number }).id;
    db.prepare(
      "INSERT INTO memory_links (from_id, to_id, kind, weight, created_at) VALUES (?, ?, 'RELATES_TO', 1.0, 1)",
    ).run(a, b);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as {
        c: number;
      }).c,
    ).toBe(1);
    db.prepare("DELETE FROM memories WHERE id = ?").run(a);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as {
        c: number;
      }).c,
    ).toBe(0);
  });

  it("migrates a v5 database to v6 idempotently (memory_links is empty + ready)", () => {
    db.exec(`
      CREATE TABLE profile_facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        keywords TEXT
      );
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        working_dir TEXT,
        tags TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        consolidating_at INTEGER
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content);
      CREATE TABLE memory_embeddings (
        memory_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (memory_id, model),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('version', '5');
    `);
    applyMigrations(db);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM memory_links")
      .get() as { c: number };
    expect(count.c).toBe(0);
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as {
        value: string;
      }
    ).value;
    expect(Number(version)).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("adds vote_score columns to memories/lessons/profile_facts on v9", () => {
    applyMigrations(db);
    for (const table of ["memories", "lessons", "profile_facts"]) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;
      const byName = new Map(cols.map((c) => [c.name, c]));
      const col = byName.get("vote_score");
      expect(col, `${table}.vote_score must exist`).toBeDefined();
      expect(col!.type.toUpperCase()).toBe("REAL");
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe("0.0");
    }
  });

  it("creates vote_events table with autoincrement id + indexes on v9", () => {
    applyMigrations(db);
    const cols = db
      .prepare(`PRAGMA table_info(vote_events)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      "id",
      "kind",
      "target_id",
      "direction",
      "session_id",
      "turn_index",
      "created_at",
    ]);
    expect(cols.find((c) => c.name === "kind")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "target_id")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "direction")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "created_at")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "id")!.pk).toBe(1);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vote_events' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_vote_events_created");
    expect(indexNames).toContain("idx_vote_events_target");

    const memoryIndexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'`,
      )
      .all() as Array<{ name: string }>;
    expect(memoryIndexes.map((i) => i.name)).toContain(
      "idx_memories_vote_score",
    );
    const lessonIndexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lessons'`,
      )
      .all() as Array<{ name: string }>;
    expect(lessonIndexes.map((i) => i.name)).toContain(
      "idx_lessons_vote_score",
    );
  });

  it("migrates a v8 database to v9 preserving existing rows with vote_score=0", () => {
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        working_dir TEXT,
        tags TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        consolidating_at INTEGER,
        consolidated_into INTEGER
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content);
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
      INSERT INTO schema_meta(key, value) VALUES ('version', '8');
      INSERT INTO memories (content, created_at, updated_at, source)
        VALUES ('legacy note', 1000, 1000, 'agent');
      INSERT INTO profile_facts (key, value, valid_from, created_at, updated_at)
        VALUES ('language', 'ru', 1000, 1000, 1000);
      INSERT INTO lessons (activation, principle, parent_ids, created_at, updated_at)
        VALUES ('when X', 'do Y', '[1]', 1000, 1000);
    `);
    applyMigrations(db);
    const mem = db
      .prepare(`SELECT content, vote_score FROM memories`)
      .get() as { content: string; vote_score: number };
    expect(mem.content).toBe("legacy note");
    expect(mem.vote_score).toBe(0);
    const fact = db
      .prepare(`SELECT key, vote_score FROM profile_facts WHERE key='language'`)
      .get() as { key: string; vote_score: number };
    expect(fact.key).toBe("language");
    expect(fact.vote_score).toBe(0);
    const lesson = db
      .prepare(`SELECT activation, vote_score FROM lessons`)
      .get() as { activation: string; vote_score: number };
    expect(lesson.activation).toBe("when X");
    expect(lesson.vote_score).toBe(0);
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as {
        value: string;
      }
    ).value;
    expect(Number(version)).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("creates procedures table + procedures_fts + indexes on v10", () => {
    applyMigrations(db);
    const cols = db
      .prepare(`PRAGMA table_info(procedures)`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      "id",
      "activation",
      "steps",
      "tags",
      "status",
      "success_count",
      "failure_count",
      "use_count",
      "vote_score",
      "parent_lesson_ids",
      "parent_memory_ids",
      "source",
      "working_dir",
      "created_at",
      "updated_at",
      "deprecated_at",
    ]);
    expect(cols.find((c) => c.name === "activation")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "steps")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "parent_lesson_ids")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "parent_memory_ids")!.notnull).toBe(1);
    expect(cols.find((c) => c.name === "id")!.pk).toBe(1);

    const ftsTables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='procedures_fts'`,
      )
      .all() as Array<{ name: string }>;
    expect(ftsTables).toHaveLength(1);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='procedures' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_procedures_status");
    expect(indexNames).toContain("idx_procedures_updated_at");
    expect(indexNames).toContain("idx_procedures_vote_score");
  });

  it("migrates a v9 database to v10 leaving existing rows untouched", () => {
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, vote_score REAL NOT NULL DEFAULT 0.0);
      CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, activation TEXT NOT NULL, principle TEXT NOT NULL, parent_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, vote_score REAL NOT NULL DEFAULT 0.0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deprecated_at INTEGER);
      INSERT INTO schema_meta(key, value) VALUES ('version', '9');
      INSERT INTO memories (content, created_at, updated_at, source) VALUES ('legacy', 1, 1, 'agent');
      INSERT INTO lessons (activation, principle, parent_ids, created_at, updated_at) VALUES ('a', 'p', '[1]', 1, 1);
    `);
    applyMigrations(db);
    const mem = db.prepare(`SELECT content FROM memories`).get() as { content: string };
    expect(mem.content).toBe("legacy");
    const lesson = db.prepare(`SELECT activation FROM lessons`).get() as { activation: string };
    expect(lesson.activation).toBe("a");
    const procCount = db
      .prepare(`SELECT COUNT(*) AS c FROM procedures`)
      .get() as { c: number };
    expect(procCount.c).toBe(0);
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as {
        value: string;
      }
    ).value;
    expect(Number(version)).toBe(MEMORY_SCHEMA_VERSION);
  });

  it("refuses to downgrade from a newer version", () => {
    applyMigrations(db);
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(MEMORY_SCHEMA_VERSION + 1));
    expect(() => applyMigrations(db)).toThrow(/newer than the supported/);
  });
});
