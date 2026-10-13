import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import type { MetricSample } from "../../tracing/metrics-collector.js";
import { MemoryStore } from "../memory-store.js";
import {
  EmbeddingUnavailableError,
  type EmbeddingClient,
} from "./embedding-client.js";
import { EmbeddingStore } from "./embedding-store.js";
import { EmbeddingWriter } from "./embedding-writer.js";
import { COSINE_ONLY_MIN_SIMILARITY, cosineSimilarity, recallHybrid, type HybridRecallDeps } from "./hybrid-recall.js";

/**
 * Memory-v2 phase 1B. Tests focus on the contract of `recallHybrid`
 * and the graceful-fallback paths around it. We deliberately bypass
 * the real llama-server by injecting a deterministic `EmbeddingClient`
 * that returns fixed vectors per keyword.
 */
function makeClient(
  vectors: Map<string, number[]>,
  opts?: { failNext?: boolean; dim?: number },
): EmbeddingClient {
  const dim = opts?.dim ?? 4;
  let failNext = opts?.failNext ?? false;
  return {
    dim,
    model: "test-model",
    async embed({ text }) {
      if (failNext) {
        failNext = false;
        throw new EmbeddingUnavailableError("synthetic failure");
      }
      // Sum any matched keyword vectors so the query "lisbon trip"
      // looks like "lisbon" + "trip" combined.
      const out = new Float32Array(dim);
      for (const [keyword, vec] of vectors) {
        if (text.toLowerCase().includes(keyword)) {
          for (let i = 0; i < dim; i += 1) out[i] += vec[i] ?? 0;
        }
      }
      return { vector: out, model: "test-model" };
    },
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(
      cosineSimilarity(
        new Float32Array([1, 0, 0, 0]),
        new Float32Array([0, 1, 0, 0]),
      ),
    ).toBeCloseTo(0, 6);
  });
  it("returns -1 for opposite vectors", () => {
    expect(
      cosineSimilarity(
        new Float32Array([1, 2, 3]),
        new Float32Array([-1, -2, -3]),
      ),
    ).toBeCloseTo(-1, 6);
  });
  it("returns 0 when either vector is zero", () => {
    expect(
      cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])),
    ).toBe(0);
  });
  it("throws on dim mismatch", () => {
    expect(() =>
      cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3])),
    ).toThrow(/dim mismatch/);
  });
});

describe("recallHybrid", () => {
  let tmp: string;
  let memStore: MemoryStore;
  let embStore: EmbeddingStore;
  let metrics: AgentMetrics;
  let captured: MetricSample[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-hybrid-"));
    memStore = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
    embStore = new EmbeddingStore({
      db: memStore.getDatabaseHandleForEmbeddings(),
    });
    captured = [];
    metrics = new AgentMetrics(
      new MetricsCollector({
        sinks: [(s: MetricSample) => captured.push(s)],
      }),
    );
  });

  afterEach(() => {
    memStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns BM25-only when embeddingClient is null (graceful)", async () => {
    const m = memStore.store({ content: "lisbon vacation plan" });
    const result = await recallHybrid(
      {
        embeddingClient: null,
        embeddingStore: null,
        bruteForceCeiling: 200,
        fts5Weight: 0.5,
        vectorWeight: 0.5,
        metrics,
      },
      {
        k: 5,
        bm25Hits: [{ ...m, bm25Score: -10 }],
        query: "lisbon",
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("lisbon vacation plan");
  });

  it("falls back to BM25 + metric on embed failure", async () => {
    const m = memStore.store({ content: "lisbon vacation plan" });
    const client = makeClient(new Map(), { failNext: true });
    const writer = new EmbeddingWriter({ client, store: embStore });
    expect(writer).toBeDefined();
    const result = await recallHybrid(
      {
        embeddingClient: client,
        embeddingStore: embStore,
        bruteForceCeiling: 200,
        fts5Weight: 0.5,
        vectorWeight: 0.5,
        metrics,
      },
      {
        k: 5,
        bm25Hits: [{ ...m, bm25Score: -10 }],
        query: "lisbon",
      },
    );
    expect(result).toHaveLength(1);
    expect(
      captured.some(
        (s) =>
          s.name === "agent.memory.embeddings.fallback_to_fts5" &&
          s.tags?.reason === "embed_failed",
      ),
    ).toBe(true);
  });

  it("emits brute_force_overflow when corpus > ceiling", async () => {
    const client = makeClient(new Map([["lisbon", [1, 0, 0, 0]]]));
    // Seed 5 embedding rows for the model "test-model" so countByModel
    // reports 5 > ceiling 2.
    for (let i = 0; i < 5; i += 1) {
      const m = memStore.store({ content: `note ${i}` });
      embStore.upsert({
        memoryId: m.id,
        model: "test-model",
        dim: 4,
        vector: new Float32Array([0, 0, 0, 1]),
        createdAt: 1,
      });
    }
    const bm25 = memStore.store({ content: "lisbon top hit" });
    const result = await recallHybrid(
      {
        embeddingClient: client,
        embeddingStore: embStore,
        bruteForceCeiling: 2,
        fts5Weight: 0.5,
        vectorWeight: 0.5,
        metrics,
      },
      {
        k: 5,
        bm25Hits: [{ ...bm25, bm25Score: -10 }],
        query: "lisbon",
      },
    );
    expect(result).toHaveLength(1);
    expect(
      captured.some(
        (s) =>
          s.name === "agent.memory.embeddings.brute_force_overflow" &&
          s.tags?.rows === "5" &&
          s.tags?.ceiling === "2",
      ),
    ).toBe(true);
  });

  it("still re-ranks an old BM25 hit by cosine above the ceiling, scanning the newest vectors plus the keyword hits'", async () => {
    const client = makeClient(new Map([["lisbon", [1, 0, 0, 0]]]));
    const vectorOf = (memoryId: number, vector: number[]) =>
      embStore.upsert({ memoryId, model: "test-model", dim: 4, vector: new Float32Array(vector), createdAt: 1 });
    const aboutLisbon = memStore.store({ content: "lisbon top hit" });
    vectorOf(aboutLisbon.id, [1, 0, 0, 0]);
    // Newer filler rows push the corpus past the ceiling.
    for (let i = 0; i < 5; i += 1) vectorOf(memStore.store({ content: `note ${i}` }).id, [0, 0, 1, 0]);
    const aboutFood = memStore.store({ content: "food memo" });
    vectorOf(aboutFood.id, [0, 1, 0, 0]);
    const fullScan = vi.spyOn(embStore, "listByModel");
    const result = await recallHybrid(
      {
        embeddingClient: client,
        embeddingStore: embStore,
        bruteForceCeiling: 2,
        fts5Weight: 0.3,
        vectorWeight: 0.7,
        metrics,
      },
      {
        k: 2,
        bm25Hits: [
          { ...aboutFood, bm25Score: -5 },
          { ...aboutLisbon, bm25Score: -5 },
        ],
        query: "lisbon",
      },
    );
    expect(result.map((r) => r.content)).toEqual(["lisbon top hit", "food memo"]);
    expect(fullScan).not.toHaveBeenCalled();
    expect(captured.some((s) => s.name === "agent.memory.embeddings.brute_force_overflow" && s.tags?.rows === "7")).toBe(true);
  });

  it("reads every vector of the model at or below the ceiling", async () => {
    const client = makeClient(new Map([["lisbon", [1, 0, 0, 0]]]));
    const m = memStore.store({ content: "lisbon top hit" });
    embStore.upsert({ memoryId: m.id, model: "test-model", dim: 4, vector: new Float32Array([1, 0, 0, 0]), createdAt: 1 });
    const fullScan = vi.spyOn(embStore, "listByModel");
    const targeted = vi.spyOn(embStore, "listByModelForMemories");
    await recallHybrid(
      { embeddingClient: client, embeddingStore: embStore, bruteForceCeiling: 200, fts5Weight: 0.5, vectorWeight: 0.5, metrics },
      { k: 1, bm25Hits: [{ ...m, bm25Score: -5 }], query: "lisbon" },
    );
    expect(fullScan).toHaveBeenCalledTimes(1);
    expect(targeted).not.toHaveBeenCalled();
    expect(captured.some((s) => s.name === "agent.memory.embeddings.brute_force_overflow")).toBe(false);
  });

  it("re-ranks BM25 hits by cosine when corpus is small", async () => {
    const client = makeClient(new Map([["lisbon", [1, 0, 0, 0]]]));
    // Two BM25 candidates. Both score the same BM25 token-wise, but
    // one has a "lisbon" embedding (cosine 1) and the other has an
    // orthogonal embedding (cosine 0). The blend should favour the
    // first.
    const aboutLisbon = memStore.store({ content: "lisbon top hit" });
    const aboutFood = memStore.store({ content: "food memo" });
    embStore.upsert({
      memoryId: aboutLisbon.id,
      model: "test-model",
      dim: 4,
      vector: new Float32Array([1, 0, 0, 0]),
      createdAt: 1,
    });
    embStore.upsert({
      memoryId: aboutFood.id,
      model: "test-model",
      dim: 4,
      vector: new Float32Array([0, 1, 0, 0]),
      createdAt: 2,
    });
    const result = await recallHybrid(
      {
        embeddingClient: client,
        embeddingStore: embStore,
        bruteForceCeiling: 200,
        fts5Weight: 0.3,
        vectorWeight: 0.7,
        metrics,
      },
      {
        k: 2,
        bm25Hits: [
          { ...aboutFood, bm25Score: -5 },
          { ...aboutLisbon, bm25Score: -5 },
        ],
        query: "lisbon",
      },
    );
    expect(result.map((r) => r.content)).toEqual([
      "lisbon top hit",
      "food memo",
    ]);
  });
});

describe("recallHybrid: notes found by meaning alone", () => {
  let tmp: string;
  let memStore: MemoryStore;
  let embStore: EmbeddingStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-hybrid-meaning-"));
    memStore = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 1000 });
    embStore = new EmbeddingStore({ db: memStore.getDatabaseHandleForEmbeddings() });
  });

  afterEach(() => {
    memStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // The query "what does my pet like" embeds to [1, 0, 0, 0]; notes get
  // hand-picked vectors so cosine is known exactly.
  const client = makeClient(new Map([["pet", [1, 0, 0, 0]], ["lisbon", [0, 1, 0, 0]]]));
  const note = (content: string, vector: number[], extra: { workingDir?: string; tags?: string[] } = {}) => {
    const m = memStore.store({ content, ...extra });
    embStore.upsert({ memoryId: m.id, model: "test-model", dim: 4, vector: new Float32Array(vector), createdAt: 1 });
    return m;
  };
  const hydrate = (ids: readonly number[]) => ids.map((id) => memStore.get(id)).filter((m) => m !== null);
  const deps = (over: Partial<HybridRecallDeps> = {}): HybridRecallDeps => ({
    embeddingClient: client, embeddingStore: embStore, bruteForceCeiling: 200,
    fts5Weight: 0.5, vectorWeight: 0.5, hydrate, ...over,
  });
  const recall = (d: HybridRecallDeps, opts: { k?: number; workingDir?: string | null; requiredTags?: string[]; bm25Hits?: Parameters<typeof recallHybrid>[1]["bm25Hits"]; query?: string } = {}) =>
    recallHybrid(d, { k: opts.k ?? 5, bm25Hits: opts.bm25Hits ?? [], query: opts.query ?? "what does my pet like", ...(opts.workingDir !== undefined ? { workingDir: opts.workingDir } : {}), ...(opts.requiredTags ? { requiredTags: opts.requiredTags } : {}) });

  it("returns a note that shares no word with the query", async () => {
    note("мой кот Барсик любит огурцы", [0.9, 0.1, 0, 0]);
    const result = await recall(deps());
    expect(result.map((r) => r.content)).toEqual(["мой кот Барсик любит огурцы"]);
    // Without a hydrator, cosine only re-ranks keyword hits, as before.
    expect(await recall(deps({ hydrate: undefined }))).toEqual([]);
  });

  it("ranks a keyword hit that also matches by meaning above a meaning-only note", async () => {
    const both = note("my pet notes", [1, 0, 0, 0]);
    note("мой кот Барсик любит огурцы", [1, 0, 0, 0]);
    const result = await recall(deps(), { bm25Hits: [{ ...both, bm25Score: -2 }] });
    expect(result.map((r) => r.content)).toEqual(["my pet notes", "мой кот Барсик любит огурцы"]);
  });

  it("applies the keyword path's filters: working dir and required tags", async () => {
    note("кот в другом проекте", [1, 0, 0, 0], { workingDir: "/other" });
    note("кот без тега", [1, 0, 0, 0], { workingDir: "/here" });
    note("кот с тегом", [1, 0, 0, 0], { workingDir: "/here", tags: ["pets"] });
    const inProject = await recall(deps(), { workingDir: "/here" });
    expect(inProject.map((r) => r.content).sort()).toEqual(["кот без тега", "кот с тегом"]);
    const tagged = await recall(deps(), { requiredTags: ["pets"] });
    expect(tagged.map((r) => r.content)).toEqual(["кот с тегом"]);
  });

  it("keeps archived notes reachable, as keyword recall does", async () => {
    const archived = note("кот Барсик", [1, 0, 0, 0]);
    memStore.archiveInto([archived.id], 1);
    expect((await recall(deps())).map((r) => r.id)).toEqual([archived.id]);
  });

  it("leaves out notes below the similarity floor", async () => {
    // cos([1,0,0,0], [0.2,1,0,0]) ≈ 0.196
    note("рецепт борща", [0.2, 1, 0, 0]);
    expect(COSINE_ONLY_MIN_SIMILARITY).toBeGreaterThan(0.2);
    expect(await recall(deps())).toEqual([]);
  });

  it("admits at most k notes on meaning alone", async () => {
    for (let i = 0; i < 4; i += 1) note(`кот ${i}`, [1, 0.01 * i, 0, 0]);
    expect(await recall(deps(), { k: 2 })).toHaveLength(2);
  });

  // A note whose cosine with the query [1, 0, 0, 0] is exactly `c`.
  const at = (c: number) => [c, Math.sqrt(1 - c * c), 0, 0];

  it("never lets meaning-only notes push an exact keyword hit out of the top k", async () => {
    const exact = note("deploy key path /etc/atomic/key.pem", at(0.05));
    for (let i = 0; i < 3; i += 1) note(`похожее ${i}`, at(0.4));
    const result = await recall(deps(), { k: 3, bm25Hits: [{ ...exact, bm25Score: -12 }] });
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(exact.id);
  });

  it("ranks keyword hits by the corrected blend: the strongest BM25 hit scores highest", async () => {
    const strong = note("strong keyword hit", at(0));
    const weak = note("weak keyword hit", at(0));
    const meaning = note("keyword hit close in meaning", at(1));
    const hits = [
      { ...weak, bm25Score: -1 },
      { ...strong, bm25Score: -10 },
      { ...meaning, bm25Score: -5 },
    ];
    // 0.5·(5/10) + 0.5·1 = 0.75 > 0.5·1 = 0.5 > 0.5·0.1 = 0.05
    const result = await recall(deps({ hydrate: undefined }), { k: 3, bm25Hits: hits });
    expect(result.map((r) => r.id)).toEqual([meaning.id, strong.id, weak.id]);
  });

  it("keeps pure BM25 order without embeddings", async () => {
    const a = note("a", at(1));
    const b = note("b", at(0));
    const hits = [{ ...a, bm25Score: -9 }, { ...b, bm25Score: -3 }];
    const result = await recall(deps({ embeddingClient: null, embeddingStore: null }), { k: 2, bm25Hits: hits });
    expect(result.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("admits only meaning-only notes close to the query's best match", async () => {
    const best = note("кот Барсик", at(0.95));
    note("что-то про животных вообще", at(0.5));
    expect((await recall(deps())).map((r) => r.id)).toEqual([best.id]);
  });

  it("honours a model's own floor", async () => {
    note("кот Барсик", at(0.5));
    expect(await recall(deps({ minCosine: 0.55 }))).toEqual([]);
    expect(await recall(deps())).toHaveLength(1);
  });

  it("admits nothing on meaning alone when the vector weight is zero", async () => {
    note("кот Барсик", at(1));
    expect(await recall(deps({ vectorWeight: 0, fts5Weight: 1 }))).toEqual([]);
  });

  it("skips a vector of another length instead of failing the recall", async () => {
    const odd = memStore.store({ content: "odd row" });
    embStore.upsert({ memoryId: odd.id, model: "test-model", dim: 2, vector: new Float32Array([1, 0]), createdAt: 1 });
    const good = note("кот Барсик", at(1));
    expect((await recall(deps())).map((r) => r.id)).toEqual([good.id]);
  });

  it("above the ceiling, reaches the newest notes and the keyword hits, not older meaning-only notes", async () => {
    const oldMeaning = note("старый кот", [1, 0, 0, 0]);
    const keyword = note("lisbon pet trip", [0, 1, 0, 0]);
    for (let i = 0; i < 3; i += 1) note(`filler ${i}`, [0, 0, 1, 0]);
    const newMeaning = note("новый кот", [1, 0, 0, 0]);
    const result = await recall(deps({ bruteForceCeiling: 2 }), { bm25Hits: [{ ...keyword, bm25Score: -5 }] });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(newMeaning.id);
    expect(ids).toContain(keyword.id);
    expect(ids).not.toContain(oldMeaning.id);
  });
});

describe("MemoryStore.recallHybridAsync with embeddings", () => {
  let tmp: string;
  let memStore: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-hybrid-store-"));
    memStore = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 1000 });
  });

  afterEach(() => {
    memStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("recalls by meaning through the store and counts it as a recall", async () => {
    // "кот" and "pet" embed alike; nothing else shares a word.
    const client = makeClient(new Map([["pet", [1, 0, 0, 0]], ["кот", [1, 0, 0, 0]], ["борщ", [0, 1, 0, 0]]]));
    const store = new EmbeddingStore({ db: memStore.getDatabaseHandleForEmbeddings() });
    memStore.attachEmbeddings({ writer: new EmbeddingWriter({ client, store }), store });
    const cat = await memStore.storeAsync({ content: "мой кот Барсик любит огурцы" });
    await memStore.storeAsync({ content: "рецепт: борщ" });
    const result = await memStore.recallHybridAsync("what does my pet like?");
    expect(result.map((r) => r.content)).toEqual(["мой кот Барсик любит огурцы"]);
    expect(result[0]).toMatchObject({ id: cat.id, tags: [], source: "agent" });
    expect(memStore.get(cat.id)?.recallCount).toBe(1);
  });

  it("is unchanged without embeddings: keyword hits only", async () => {
    memStore.store({ content: "мой кот Барсик любит огурцы" });
    expect(await memStore.recallHybridAsync("what does my pet like?")).toEqual([]);
  });
});

describe("EmbeddingWriter.writeFor", () => {
  let tmp: string;
  let memStore: MemoryStore;
  let embStore: EmbeddingStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-embwriter-"));
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

  it("returns true and persists on happy path", async () => {
    const client = makeClient(new Map([["foo", [1, 0, 0, 0]]]));
    const writer = new EmbeddingWriter({ client, store: embStore });
    const m = memStore.store({ content: "foo bar" });
    const ok = await writer.writeFor(m.id, "foo bar");
    expect(ok).toBe(true);
    const row = embStore.get(m.id, "test-model");
    expect(row).not.toBeNull();
    expect(Array.from(row!.vector)).toEqual([1, 0, 0, 0]);
  });

  it("returns false on EmbeddingUnavailableError (never throws)", async () => {
    const client = makeClient(new Map(), { failNext: true });
    const writer = new EmbeddingWriter({ client, store: embStore });
    const m = memStore.store({ content: "foo" });
    const ok = await writer.writeFor(m.id, "foo");
    expect(ok).toBe(false);
    expect(embStore.get(m.id, "test-model")).toBeNull();
  });

  it("returns false on generic errors (never throws)", async () => {
    const client: EmbeddingClient = {
      dim: 4,
      model: "test-model",
      embed: vi.fn().mockRejectedValue(new RangeError("kaboom")),
    };
    const writer = new EmbeddingWriter({ client, store: embStore });
    const m = memStore.store({ content: "foo" });
    const ok = await writer.writeFor(m.id, "foo");
    expect(ok).toBe(false);
  });
});
