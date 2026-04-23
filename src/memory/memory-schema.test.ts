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

  it("refuses to downgrade from a newer version", () => {
    applyMigrations(db);
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(MEMORY_SCHEMA_VERSION + 1));
    expect(() => applyMigrations(db)).toThrow(/newer than the supported/);
  });
});
