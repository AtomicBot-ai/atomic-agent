import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";
import { EmbeddingStore } from "./embedding-store.js";

describe("EmbeddingStore", () => {
  let tmp: string;
  let memStore: MemoryStore;
  let embStore: EmbeddingStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-embstore-"));
    memStore = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 100,
    });
    embStore = new EmbeddingStore({
      db: memStore.getDatabaseHandleForEmbeddings(),
    });
  });

  afterEach(() => {
    memStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a Float32Array through upsert + get", () => {
    const m = memStore.store({ content: "phase 1B" });
    const vec = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    embStore.upsert({
      memoryId: m.id,
      model: "test-model",
      dim: 4,
      vector: vec,
      createdAt: 1000,
    });
    const got = embStore.get(m.id, "test-model");
    expect(got).not.toBeNull();
    expect(got!.dim).toBe(4);
    expect(Array.from(got!.vector)).toEqual([
      0.10000000149011612,
      -0.20000000298023224,
      0.30000001192092896,
      -0.4000000059604645,
    ]);
  });

  it("rejects vector / dim mismatch on upsert", () => {
    const m = memStore.store({ content: "x" });
    expect(() =>
      embStore.upsert({
        memoryId: m.id,
        model: "m",
        dim: 4,
        vector: new Float32Array([1, 2]),
        createdAt: 1,
      }),
    ).toThrow(/length 2 != dim 4/);
  });

  it("supports multiple models per memory id (composite PK)", () => {
    const m = memStore.store({ content: "x" });
    embStore.upsert({
      memoryId: m.id,
      model: "model-a",
      dim: 2,
      vector: new Float32Array([1, 0]),
      createdAt: 1,
    });
    embStore.upsert({
      memoryId: m.id,
      model: "model-b",
      dim: 3,
      vector: new Float32Array([0, 1, 0]),
      createdAt: 2,
    });
    expect(embStore.countByModel("model-a")).toBe(1);
    expect(embStore.countByModel("model-b")).toBe(1);
    expect(embStore.get(m.id, "model-a")!.dim).toBe(2);
    expect(embStore.get(m.id, "model-b")!.dim).toBe(3);
  });

  it("listByModel joins memory metadata (workingDir, tags)", () => {
    const a = memStore.store({
      content: "scoped fact",
      workingDir: "/project/a",
      tags: ["alpha"],
    });
    const b = memStore.store({
      content: "global fact",
      workingDir: null,
    });
    embStore.upsert({
      memoryId: a.id,
      model: "m",
      dim: 2,
      vector: new Float32Array([1, 0]),
      createdAt: 1,
    });
    embStore.upsert({
      memoryId: b.id,
      model: "m",
      dim: 2,
      vector: new Float32Array([0, 1]),
      createdAt: 2,
    });
    const rows = embStore.listByModel("m").sort(
      (x, y) => x.memoryId - y.memoryId,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.workingDir).toBe("/project/a");
    expect(rows[0]!.tags).toEqual(["alpha"]);
    expect(rows[1]!.workingDir).toBeNull();
    expect(rows[1]!.tags).toEqual([]);
  });

  it("cascades delete from memories -> memory_embeddings (FK ON)", () => {
    const m = memStore.store({ content: "to be deleted" });
    embStore.upsert({
      memoryId: m.id,
      model: "m",
      dim: 2,
      vector: new Float32Array([1, 1]),
      createdAt: 1,
    });
    expect(embStore.countByModel("m")).toBe(1);
    memStore.remove(m.id);
    expect(embStore.countByModel("m")).toBe(0);
  });

  it("UPSERT overwrites existing (memory_id, model) row in place", () => {
    const m = memStore.store({ content: "x" });
    embStore.upsert({
      memoryId: m.id,
      model: "m",
      dim: 2,
      vector: new Float32Array([1, 0]),
      createdAt: 100,
    });
    embStore.upsert({
      memoryId: m.id,
      model: "m",
      dim: 2,
      vector: new Float32Array([0, 1]),
      createdAt: 200,
    });
    expect(embStore.countByModel("m")).toBe(1);
    const got = embStore.get(m.id, "m");
    expect(got!.createdAt).toBe(200);
    expect(Array.from(got!.vector)).toEqual([0, 1]);
  });

  it("deleteAllForModel wipes one model without touching the other", () => {
    const m = memStore.store({ content: "x" });
    embStore.upsert({
      memoryId: m.id,
      model: "old",
      dim: 2,
      vector: new Float32Array([1, 0]),
      createdAt: 1,
    });
    embStore.upsert({
      memoryId: m.id,
      model: "new",
      dim: 2,
      vector: new Float32Array([0, 1]),
      createdAt: 2,
    });
    embStore.deleteAllForModel("old");
    expect(embStore.countByModel("old")).toBe(0);
    expect(embStore.countByModel("new")).toBe(1);
  });
});
