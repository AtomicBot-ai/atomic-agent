import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, MEMORY_SCHEMA_VERSION } from "./memory-schema.js";

describe("applyMigrations", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mem-"));
    db = new Database(join(tmp, "memory.sqlite"));
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

  it("refuses to downgrade from a newer version", () => {
    applyMigrations(db);
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(MEMORY_SCHEMA_VERSION + 1));
    expect(() => applyMigrations(db)).toThrow(/newer than the supported/);
  });
});
