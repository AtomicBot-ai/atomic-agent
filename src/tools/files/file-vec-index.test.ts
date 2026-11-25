import type Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFileIndexDb } from "./file-index-schema.js";
import { FileIndexStore } from "./file-index-store.js";
import { loadSqliteVec } from "./file-vec-extension.js";
import { FileVecIndex } from "./file-vec-index.js";
import { FileVectorStore } from "./file-vector-store.js";

const AT = "2026-11-18T10:00:00.000Z";
const DOCS = join("/", "docs");

let db: Database.Database;
let store: FileIndexStore;
let vectors: FileVectorStore;

beforeEach(() => {
  db = openFileIndexDb(":memory:");
  store = new FileIndexStore(db);
  vectors = new FileVectorStore(db);
});
afterEach(() => db.close());

function chunks(texts: string[]): number[] {
  store.addFolder(DOCS, AT);
  store.upsertSeen(DOCS, join(DOCS, "a.txt"), 1, 1, undefined);
  return store.saveChunks(store.nextPending()!.id, texts.map((text, ord) => ({ ord, text })), AT)!;
}

/** Whether `sqlite-vec` is installed here; it is not a dependency, so usually not. */
const probe = openFileIndexDb(":memory:");
const SQLITE_VEC = await loadSqliteVec(probe);
probe.close();

describe("FileVecIndex without the extension", () => {
  it("turns itself off and answers null, so search scans instead", () => {
    const [id] = chunks(["one"]);
    const vec = new FileVecIndex(db, vectors);
    vectors.setMirror(vec);
    vectors.put(id!, "m", new Float32Array([1, 0]));
    expect(vec.nearest("m", new Float32Array([1, 0]), 5)).toBeNull();
    expect(vec.active).toBe(false);
    // The plain table still has the vector.
    expect(vectors.countFor("m", 2)).toBe(1);
  });

  it("the loader answers false (never throws) when the package is missing or broken", async () => {
    if (SQLITE_VEC) return;
    const other = openFileIndexDb(":memory:");
    await expect(loadSqliteVec(other)).resolves.toBe(false);
    other.close();
  });

  it("ignores a dimension it cannot index", () => {
    const vec = new FileVecIndex(db, vectors);
    expect(vec.nearest("m", new Float32Array(0), 5)).toBeNull();
  });
});

describe.skipIf(!SQLITE_VEC)("FileVecIndex with sqlite-vec installed", () => {
  beforeEach(async () => {
    expect(await loadSqliteVec(db)).toBe(true);
  });

  it("mirrors writes and answers the nearest chunk ids", () => {
    const [a, b, c] = chunks(["one", "two", "three"]);
    const vec = new FileVecIndex(db, vectors);
    vectors.setMirror(vec);
    vectors.put(a!, "m", new Float32Array([1, 0, 0]));
    vectors.put(b!, "m", new Float32Array([0, 1, 0]));
    vectors.put(c!, "m", new Float32Array([0.9, 0.1, 0]));
    expect(vec.nearest("m", new Float32Array([1, 0, 0]), 2)).toEqual([a, c]);
    expect(vec.active).toBe(true);
  });

  it("backfills vectors written before it was attached and drops removed ones", () => {
    const [a, b] = chunks(["one", "two"]);
    vectors.put(a!, "m", new Float32Array([1, 0]));
    vectors.put(b!, "m", new Float32Array([0, 1]));
    const vec = new FileVecIndex(db, vectors);
    vectors.setMirror(vec);
    expect(vec.nearest("m", new Float32Array([0, 1]), 1)).toEqual([b]);
    store.removeFolder(DOCS);
    expect(vec.nearest("m", new Float32Array([0, 1]), 5)).toEqual([]);
  });

  it("keeps models and dimensions apart", () => {
    const [a, b] = chunks(["one", "two"]);
    const vec = new FileVecIndex(db, vectors);
    vectors.setMirror(vec);
    vectors.put(a!, "m1", new Float32Array([1, 0]));
    vectors.put(b!, "m2", new Float32Array([1, 0, 0]));
    expect(vec.nearest("m1", new Float32Array([1, 0]), 5)).toEqual([a]);
    expect(vec.nearest("m2", new Float32Array([1, 0, 0]), 5)).toEqual([b]);
  });
});
