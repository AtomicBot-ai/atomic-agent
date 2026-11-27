import type Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFileIndexDb } from "./file-index-schema.js";
import { FileIndexStore } from "./file-index-store.js";
import { loadSqliteVec } from "./file-vec-extension.js";
import { FileVecIndex, vecTableName } from "./file-vec-index.js";
import { FileVectorStore } from "./file-vector-store.js";

/**
 * ATO-1657: a resync reads only the blobs of rows the mirror lacks, and a
 * row that never decodes does not force a resync (and a scan) every time.
 * Without `sqlite-vec` a plain table with the mirror's name stands in for
 * the vec0 table: the resync only inserts, deletes and counts, which a
 * plain table answers the same way (`CREATE VIRTUAL TABLE IF NOT EXISTS`
 * keeps the existing one).
 */

const AT = "2026-11-27T10:00:00.000Z";
const DOCS = join("/", "docs");

let db: Database.Database;
let store: FileIndexStore;
let vectors: FileVectorStore;
let blobReads: number;

beforeEach(() => {
  db = openFileIndexDb(":memory:");
  store = new FileIndexStore(db);
  vectors = new FileVectorStore(db);
  blobReads = 0;
  countBlobReads(db);
});
afterEach(() => db.close());

function chunks(count: number): number[] {
  store.addFolder(DOCS, AT);
  store.upsertSeen(DOCS, join(DOCS, "a.txt"), 1, 1, undefined);
  const texts = Array.from({ length: count }, (_, ord) => ({ ord, text: `chunk ${ord}` }));
  return store.saveChunks(store.nextPending()!.id, texts, AT)!;
}

/** Count every `chunk_vectors.vector` blob a statement hands back. */
function countBlobReads(target: Database.Database): void {
  const prepare = target.prepare.bind(target);
  const counted = (rows: unknown[]): void => {
    for (const row of rows) if (row !== null && typeof row === "object" && Buffer.isBuffer((row as { vector?: unknown }).vector)) blobReads++;
  };
  (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql) as unknown as {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      iterate: (...args: unknown[]) => IterableIterator<unknown>;
    };
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    const iterate = stmt.iterate.bind(stmt);
    stmt.all = (...args) => {
      const rows = all(...args);
      counted(rows);
      return rows;
    };
    stmt.get = (...args) => {
      const row = get(...args);
      counted([row]);
      return row;
    };
    stmt.iterate = function* (...args) {
      for (const row of iterate(...args)) {
        counted([row]);
        yield row;
      }
    };
    return stmt;
  };
}

function plainMirror(model: string, dim: number): string {
  const name = vecTableName(model, dim);
  db.exec(`CREATE TABLE ${name} (embedding BLOB)`);
  return name;
}

function rows(table: string): number[] {
  return (db.prepare(`SELECT rowid AS id FROM ${table} ORDER BY rowid`).all() as { id: number }[]).map((row) => Number(row.id));
}

function putCorrupt(chunkId: number, model: string, dim: number): void {
  // Three bytes: no dimension decodes it.
  db.prepare(`INSERT INTO chunk_vectors (chunk_id, model, dim, vector) VALUES (?, ?, ?, ?)`).run(chunkId, model, dim, Buffer.from([1, 2, 3]));
}

describe("FileVecIndex resync (ATO-1657)", () => {
  it("after one change reads only the new row's blob", () => {
    const ids = chunks(51);
    for (const id of ids.slice(0, 50)) vectors.put(id, "m", new Float32Array([id, 1]));
    const table = plainMirror("m", 2);
    const vec = new FileVecIndex(db, vectors);
    expect(vec.sync("m", 2)).toBe(true);
    expect(rows(table)).toHaveLength(50);

    // Written while the mirror was not attached: one row to catch up.
    vectors.put(ids[50]!, "m", new Float32Array([7, 1]));
    blobReads = 0;
    expect(vec.sync("m", 2)).toBe(true);
    expect(blobReads).toBe(1);
    expect(rows(table)).toEqual(ids);
  });

  it("drops an orphan without reading any blob", () => {
    const ids = chunks(20);
    for (const id of ids) vectors.put(id, "m", new Float32Array([1, id]));
    const table = plainMirror("m", 2);
    const vec = new FileVecIndex(db, vectors);
    expect(vec.sync("m", 2)).toBe(true);

    db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id = ?`).run(ids[3]!);
    blobReads = 0;
    expect(vec.sync("m", 2)).toBe(true);
    expect(blobReads).toBe(0);
    expect(rows(table)).toEqual(ids.filter((id) => id !== ids[3]));
  });

  it("skips a row that never decodes instead of resyncing on every search", () => {
    const [a, b, bad] = chunks(3);
    vectors.put(a!, "m", new Float32Array([1, 0]));
    vectors.put(b!, "m", new Float32Array([0, 1]));
    putCorrupt(bad!, "m", 2);
    const table = plainMirror("m", 2);
    const vec = new FileVecIndex(db, vectors);
    expect(vec.sync("m", 2)).toBe(true);
    expect(rows(table)).toEqual([a, b]);

    blobReads = 0;
    expect(vec.sync("m", 2)).toBe(true);
    expect(vec.sync("m", 2)).toBe(true);
    expect(blobReads).toBe(0);
    expect(vec.active).toBe(true);
  });

  it("mirrors a skipped row once put rewrites it", () => {
    const [a, bad] = chunks(2);
    vectors.put(a!, "m", new Float32Array([1, 0]));
    putCorrupt(bad!, "m", 2);
    const table = plainMirror("m", 2);
    const vec = new FileVecIndex(db, vectors);
    vectors.setMirror(vec);
    expect(vec.sync("m", 2)).toBe(true);

    vectors.put(bad!, "m", new Float32Array([0, 1]));
    expect(rows(table)).toEqual([a, bad]);
    blobReads = 0;
    expect(vec.sync("m", 2)).toBe(true);
    expect(blobReads).toBe(0);
  });

  it("forgets a skipped row once it is deleted", () => {
    const [a, bad, c] = chunks(3);
    vectors.put(a!, "m", new Float32Array([1, 0]));
    putCorrupt(bad!, "m", 2);
    const table = plainMirror("m", 2);
    const vec = new FileVecIndex(db, vectors);
    expect(vec.sync("m", 2)).toBe(true);

    db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id = ?`).run(bad!);
    expect(vec.sync("m", 2)).toBe(true);
    // A new row is then picked up: the stale skip does not hide the gap.
    vectors.put(c!, "m", new Float32Array([0, 1]));
    expect(vec.sync("m", 2)).toBe(true);
    expect(rows(table)).toEqual([a, c]);
  });
});

const probe = openFileIndexDb(":memory:");
const SQLITE_VEC = await loadSqliteVec(probe);
probe.close();

describe.skipIf(!SQLITE_VEC)("FileVecIndex with a corrupt row and sqlite-vec installed", () => {
  it("answers from the mirror every time instead of falling back to a scan", async () => {
    expect(await loadSqliteVec(db)).toBe(true);
    const [a, b, bad] = chunks(3);
    vectors.put(a!, "m", new Float32Array([1, 0]));
    vectors.put(b!, "m", new Float32Array([0, 1]));
    putCorrupt(bad!, "m", 2);
    const vec = new FileVecIndex(db, vectors);
    expect(vec.nearest("m", new Float32Array([1, 0]), 1)).toEqual([a]);
    blobReads = 0;
    expect(vec.nearest("m", new Float32Array([0, 1]), 1)).toEqual([b]);
    expect(blobReads).toBe(0);
  });
});
