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
import { cosineSimilarity, recallHybrid } from "./hybrid-recall.js";

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
      cosineSimilarity(
        new Float32Array([1, 2]),
        new Float32Array([1, 2, 3]),
      ),
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
        bm25Hits: [
          { ...m, bm25Score: -10 },
        ],
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

  it("skips cosine + emits brute_force_overflow when corpus > ceiling", async () => {
    const client = makeClient(
      new Map([
        ["lisbon", [1, 0, 0, 0]],
      ]),
    );
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

  it("re-ranks BM25 hits by cosine when corpus is small", async () => {
    const client = makeClient(
      new Map([
        ["lisbon", [1, 0, 0, 0]],
      ]),
    );
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
