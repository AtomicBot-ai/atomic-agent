import type Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFileIndexDb, FILE_INDEX_SCHEMA_VERSION } from "./file-index-schema.js";
import { FileIndexStore, likePrefix } from "./file-index-store.js";
import { FileVectorStore } from "./file-vector-store.js";

let db: Database.Database;
let store: FileIndexStore;
let vectors: FileVectorStore;
const AT = "2026-11-18T10:00:00.000Z";
const DOCS = join("/", "docs");
const pdf = join(DOCS, "report.pdf");
const notes = join(DOCS, "notes.md");

beforeEach(() => {
  db = openFileIndexDb(":memory:");
  store = new FileIndexStore(db);
  vectors = new FileVectorStore(db);
});
afterEach(() => db.close());

function ftsRows(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"termination"*'`).get() as { n: number }).n;
}

describe("FileIndexStore", () => {
  it("creates the schema at its version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(FILE_INDEX_SCHEMA_VERSION);
  });

  it("adds a folder and counts its files and indexed files", () => {
    const folder = store.addFolder(DOCS, AT);
    expect(folder).toEqual({ path: DOCS, name: "docs", fileCount: 0, indexedCount: 0, addedAt: AT });
    store.upsertSeen(DOCS, pdf, 1000, 10, undefined);
    store.upsertSeen(DOCS, notes, 1000, 10, undefined);
    const row = store.nextPending()!;
    expect(row.path).toBe(pdf);
    expect(store.saveChunks(row.id, [{ ord: 0, page: 12, text: "Termination needs notice." }], AT)).toHaveLength(1);
    expect(store.listFolders()).toEqual([{ path: DOCS, name: "docs", fileCount: 2, indexedCount: 1, addedAt: AT }]);
    expect(store.counts()).toEqual({ found: 2, indexed: 1, failed: 0, skipped: 0, pending: 1 });
  });

  it("finds chunks by keyword with page and snippet, under a folder only when asked", () => {
    store.addFolder(DOCS, AT);
    store.addFolder(join("/", "other"), AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    store.upsertSeen(join("/", "other"), join("/", "other", "x.txt"), 1, 1, undefined);
    store.saveChunks(store.nextPending()!.id, [{ ord: 0, page: 12, text: "Termination needs thirty days notice." }], AT);
    store.saveChunks(store.nextPending()!.id, [{ ord: 0, text: "Termination of the lease." }], AT);
    const all = store.matchChunks('"termination"*', null, 10);
    expect(all.map((m) => m.path).sort()).toEqual([pdf, join("/", "other", "x.txt")].sort());
    const docsOnly = store.matchChunks('"termination"*', DOCS, 10);
    expect(docsOnly).toHaveLength(1);
    expect(docsOnly[0]).toMatchObject({ path: pdf, page: 12, timeSec: null });
    expect(docsOnly[0]!.snippet).toContain("«Termination»");
    expect(docsOnly[0]!.bm25).toBeLessThan(0);
  });

  it("a changed file goes back to pending and loses its chunks; an unchanged one is left alone", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1000, 10, undefined);
    store.saveChunks(store.nextPending()!.id, [{ ord: 0, text: "termination" }], AT);
    store.upsertSeen(DOCS, pdf, 1000, 10, store.filesIn(DOCS).get(pdf));
    expect(store.counts().indexed).toBe(1);
    store.upsertSeen(DOCS, pdf, 2000, 10, store.filesIn(DOCS).get(pdf));
    expect(store.counts()).toMatchObject({ indexed: 0, pending: 1 });
    expect(ftsRows()).toBe(0);
  });

  it("a file over the size cap is recorded as skipped", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 10, undefined, "too large");
    expect(store.counts()).toEqual({ found: 1, indexed: 0, failed: 0, skipped: 1, pending: 0 });
    expect(store.nextPending()).toBeUndefined();
  });

  it("removing a folder drops its files, chunks, vectors and FTS rows", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    const [chunkId] = store.saveChunks(store.nextPending()!.id, [{ ord: 0, text: "termination clause" }], AT)!;
    vectors.put(chunkId!, "m", new Float32Array([1, 0]));
    expect(store.removeFolder(DOCS)).toBe(true);
    expect(store.removeFolder(DOCS)).toBe(false);
    expect(store.counts().found).toBe(0);
    expect(vectors.countFor("m")).toBe(0);
    expect(ftsRows()).toBe(0);
  });

  it("saveChunks answers null for a file removed while it was being read", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    const id = store.nextPending()!.id;
    store.removeFolder(DOCS);
    expect(store.saveChunks(id, [{ ord: 0, text: "late" }], AT)).toBeNull();
  });

  it("adding a parent folder takes in the folders inside it", () => {
    const inner = join(DOCS, "inner");
    store.addFolder(inner, AT);
    store.upsertSeen(inner, join(inner, "a.txt"), 1, 1, undefined);
    store.addFolder(DOCS, AT);
    expect(store.folderPaths()).toEqual([DOCS]);
    expect(store.listFolders()[0]!.fileCount).toBe(1);
  });

  it("deleteFiles removes vanished files", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    store.deleteFiles([store.filesIn(DOCS).get(pdf)!.id]);
    expect(store.counts().found).toBe(0);
  });

  it("markFile records failed and skipped", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    store.upsertSeen(DOCS, notes, 1, 1, undefined);
    store.markFile(store.filesIn(DOCS).get(pdf)!.id, "failed", "broken");
    store.markFile(store.filesIn(DOCS).get(notes)!.id, "skipped", "no text");
    expect(store.counts()).toEqual({ found: 2, indexed: 0, failed: 1, skipped: 1, pending: 0 });
  });
});

describe("FileVectorStore", () => {
  it("lists chunks missing a vector for a model and scans what it has", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    const ids = store.saveChunks(store.nextPending()!.id, [{ ord: 0, text: "one" }, { ord: 1, text: "two" }], AT)!;
    expect(vectors.missing("m", 10).map((c) => c.chunkId)).toEqual(ids);
    vectors.put(ids[0]!, "m", new Float32Array([0.5, 0.25]));
    expect(vectors.missing("m", 10).map((c) => c.chunkId)).toEqual([ids[1]]);
    expect(vectors.missing("other", 10)).toHaveLength(2);
    const scanned = vectors.scan("m", DOCS, 10);
    expect(scanned).toHaveLength(1);
    expect([...scanned[0]!.vector]).toEqual([0.5, 0.25]);
    expect(vectors.scan("m", join("/", "elsewhere"), 10)).toEqual([]);
  });

  it("with a query, an old chunk that matches best is still a candidate past the scan limit", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    const texts = Array.from({ length: 6 }, (_, i) => ({ ord: i, text: `chunk ${i}` }));
    const ids = store.saveChunks(store.nextPending()!.id, texts, AT)!;
    // The oldest chunk (lowest id) points the query's way; the newer ones do not.
    vectors.put(ids[0]!, "m", new Float32Array([1, 0]));
    for (const id of ids.slice(1)) vectors.put(id, "m", new Float32Array([0, 1]));
    const query = new Float32Array([1, 0]);
    expect(vectors.scan("m", null, 2).map((c) => c.chunkId)).not.toContain(ids[0]);
    const scored = vectors.scan("m", null, 2, [], query);
    expect(scored).toHaveLength(2);
    expect(scored[0]!.chunkId).toBe(ids[0]);
  });
});

describe("FileVectorStore for the sqlite-vec path (ATO-1052)", () => {
  it("reads vectors back by chunk id, counts per dimension and copies writes to a mirror", () => {
    store.addFolder(DOCS, AT);
    store.upsertSeen(DOCS, pdf, 1, 1, undefined);
    const ids = store.saveChunks(store.nextPending()!.id, [{ ord: 0, text: "one" }, { ord: 1, text: "two" }], AT)!;
    const mirrored: number[] = [];
    vectors.setMirror({ put: (chunkId) => mirrored.push(chunkId) });
    vectors.put(ids[0]!, "m", new Float32Array([1, 0]));
    vectors.put(ids[1]!, "m", new Float32Array([1, 0, 0]));
    expect(mirrored).toEqual(ids);
    expect(vectors.countFor("m")).toBe(2);
    expect(vectors.countFor("m", 2)).toBe(1);
    expect(vectors.byIds("m", [ids[1]!, ids[1]!, 9999]).map((v) => v.chunkId)).toEqual([ids[1]]);
    expect(vectors.byIds("m", [])).toEqual([]);
  });
});

describe("likePrefix", () => {
  it("escapes LIKE wildcards in the folder path", () => {
    expect(likePrefix("/a_b%c")).toBe("/a\\_b\\%c/%");
  });
});
