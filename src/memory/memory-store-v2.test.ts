import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "./memory-store.js";
import { AgentMetrics } from "../tracing/agent-metrics.js";
import { MetricsCollector } from "../tracing/metrics-collector.js";
import type { MetricSample } from "../tracing/metrics-collector.js";

/**
 * Memory-v2 phase 1A test suite. The original `memory-store.test.ts`
 * pins the v1 contract (FIFO eviction, no dedup); this file pins the
 * new behaviours behind the `dedup` / `eviction` options so the v1
 * back-compat path stays observably identical for callers that omit
 * the new options.
 */
describe("MemoryStore v2 phase 1A", () => {
  let tmp: string;
  let captured: MetricSample[];
  let metrics: AgentMetrics;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-memv2-"));
    captured = [];
    metrics = new AgentMetrics(
      new MetricsCollector({
        sinks: [(sample: MetricSample) => captured.push(sample)],
      }),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(opts: {
    maxEntries?: number;
    dedup?: { enabled: boolean; fts5Threshold: number };
    eviction?: { utilityWeighted: boolean; maxAgeMs: number };
    now?: () => number;
  } = {}): MemoryStore {
    return new MemoryStore({
      dbFile: join(tmp, `${captured.length}.sqlite`),
      maxEntries: opts.maxEntries ?? 100,
      dedup: opts.dedup,
      eviction: opts.eviction,
      metrics,
      now: opts.now,
    });
  }

  describe("recall_count plumbing", () => {
    it("defaults to 0 / null on fresh insert", () => {
      const store = makeStore();
      try {
        const e = store.store({ content: "fresh row" }, 1_000);
        expect(e.recallCount).toBe(0);
        expect(e.lastRecalledAt).toBeNull();
      } finally {
        store.close();
      }
    });

    it("recall bumps recall_count + stamps last_recalled_at", () => {
      const store = makeStore({ now: () => 5_000 });
      try {
        const inserted = store.store({ content: "alpha bravo charlie" }, 1_000);
        const first = store.recall("alpha");
        expect(first).toHaveLength(1);
        expect(first[0]?.recallCount).toBe(1);
        expect(first[0]?.lastRecalledAt).toBe(5_000);
        const persisted = store.get(inserted.id);
        expect(persisted?.recallCount).toBe(1);
        expect(persisted?.lastRecalledAt).toBe(5_000);

        const second = store.recall("bravo");
        expect(second[0]?.recallCount).toBe(2);
      } finally {
        store.close();
      }
    });

    it("recall touches each returned row exactly once per call", () => {
      const store = makeStore({ now: () => 2_000 });
      try {
        store.store({ content: "first apple banana" }, 100);
        store.store({ content: "second apple cherry" }, 200);
        const hits = store.recall("apple", { k: 2 });
        expect(hits).toHaveLength(2);
        const ids = hits.map((h) => h.id).sort((a, b) => a - b);
        for (const id of ids) {
          expect(store.get(id)?.recallCount).toBe(1);
        }
      } finally {
        store.close();
      }
    });

    it("emits clock_skew_detected metric when recall fires against a future-dated row", () => {
      // Future timestamp on the stored row, recall happens "now=0" ⇒ delta < 0.
      const store = makeStore({ now: () => 0 });
      try {
        store.store({ content: "future row" }, 10_000);
        store.recall("future");
        const skew = captured.filter(
          (m) => m.name === "agent.memory.clock_skew_detected",
        );
        expect(skew).toHaveLength(1);
        expect(skew[0]?.tags?.site).toBe("memory_store_recall");
      } finally {
        store.close();
      }
    });
  });

  describe("FTS5 near-match dedup", () => {
    it("merges a verbatim duplicate when dedup.enabled=true", () => {
      const store = makeStore({
        dedup: { enabled: true, fts5Threshold: 0.85 },
      });
      try {
        const a = store.store(
          { content: "the user prefers concise answers" },
          1_000,
        );
        const b = store.store(
          { content: "the user prefers concise answers" },
          2_000,
        );
        expect(b.id).toBe(a.id);
        expect(store.count()).toBe(1);
        expect(b.updatedAt).toBe(2_000);
        expect(b.recallCount).toBe(1); // bumped by the merge

        const mergedSamples = captured.filter(
          (m) => m.name === "agent.memory.dedup.merged",
        );
        expect(mergedSamples).toHaveLength(1);
        expect(mergedSamples[0]?.tags?.candidateId).toBe(String(a.id));
      } finally {
        store.close();
      }
    });

    it("inserts a fresh row when content is dissimilar (skipped outcome)", () => {
      const store = makeStore({
        dedup: { enabled: true, fts5Threshold: 0.85 },
      });
      try {
        store.store({ content: "alpha beta gamma" }, 1_000);
        store.store({ content: "delta epsilon zeta" }, 2_000);
        expect(store.count()).toBe(2);
        const skipped = captured.filter(
          (m) => m.name === "agent.memory.dedup.skipped",
        );
        // Two writes: first has no candidate (skipped), second has a
        // candidate below threshold (skipped). Both contribute.
        expect(skipped.length).toBeGreaterThanOrEqual(1);
      } finally {
        store.close();
      }
    });

    it("refuses to merge when tag sets are incompatible (different topic)", () => {
      const store = makeStore({
        dedup: { enabled: true, fts5Threshold: 0.5 },
      });
      try {
        const a = store.store(
          { content: "shared tokens overlap heavily", tags: ["foo"] },
          1_000,
        );
        const b = store.store(
          { content: "shared tokens overlap heavily", tags: ["bar"] },
          2_000,
        );
        // Same content, different tag ⇒ not a superset, no merge.
        expect(b.id).not.toBe(a.id);
        expect(store.count()).toBe(2);
      } finally {
        store.close();
      }
    });

    it("merges when existing.tags is a strict superset of new.tags", () => {
      const store = makeStore({
        dedup: { enabled: true, fts5Threshold: 0.85 },
      });
      try {
        const a = store.store(
          { content: "merge me please", tags: ["foo", "bar"] },
          1_000,
        );
        const b = store.store(
          { content: "merge me please", tags: ["foo"] },
          2_000,
        );
        expect(b.id).toBe(a.id);
        expect(b.tags).toEqual(["foo", "bar"]); // existing superset preserved
      } finally {
        store.close();
      }
    });

    it("disabled flag emits the 'disabled' outcome and never merges", () => {
      const store = makeStore({
        dedup: { enabled: false, fts5Threshold: 0.85 },
      });
      try {
        const a = store.store({ content: "identical content" }, 1_000);
        const b = store.store({ content: "identical content" }, 2_000);
        expect(b.id).not.toBe(a.id);
        const disabled = captured.filter(
          (m) =>
            m.name === "agent.memory.dedup.skipped" &&
            m.tags?.outcome === "disabled",
        );
        expect(disabled.length).toBeGreaterThanOrEqual(2);
      } finally {
        store.close();
      }
    });

    it("default (no options) preserves v1 behaviour: never merges", () => {
      // Bare constructor — same shape as legacy tests.
      const store = new MemoryStore({
        dbFile: join(tmp, "legacy.sqlite"),
        maxEntries: 10,
      });
      try {
        const a = store.store({ content: "same content" }, 1);
        const b = store.store({ content: "same content" }, 2);
        expect(b.id).not.toBe(a.id);
        expect(store.count()).toBe(2);
      } finally {
        store.close();
      }
    });
  });

  describe("utility-weighted overflow eviction", () => {
    it("evicts the least-recalled row first when over maxEntries", () => {
      const store = makeStore({
        maxEntries: 3,
        eviction: { utilityWeighted: true, maxAgeMs: 1_000_000 },
        now: () => 100,
      });
      try {
        const survivor = store.store({ content: "important alpha" }, 1);
        store.store({ content: "neutral beta" }, 2);
        store.store({ content: "neutral gamma" }, 3);
        // Bump recall_count on the survivor so it has utility > 0.
        store.recall("alpha");
        // Fourth insert ⇒ overflow eviction. With utility-weighted
        // ordering, the survivor's recall_count=1 outranks
        // the neutral rows' recall_count=0.
        store.store({ content: "fresh delta" }, 4);
        expect(store.count()).toBe(3);
        expect(store.get(survivor.id)).not.toBeNull();

        const evictionSamples = captured.filter(
          (m) => m.name === "agent.memory.eviction.evicted",
        );
        expect(evictionSamples.length).toBeGreaterThanOrEqual(1);
        expect(evictionSamples[0]?.tags?.utilityWeighted).toBe("true");
      } finally {
        store.close();
      }
    });

    it("falls back to legacy FIFO when utilityWeighted=false (default)", () => {
      // Reproduces the v1 test: the first inserted row is the first
      // evicted when overflow fires, regardless of recall pattern.
      const store = makeStore({
        maxEntries: 3,
        eviction: { utilityWeighted: false, maxAgeMs: 1_000_000 },
      });
      try {
        const first = store.store({ content: "first row" }, 1);
        store.store({ content: "second row" }, 2);
        store.store({ content: "third row" }, 3);
        // Recall the first row twice — recall_count climbs, but the
        // legacy FIFO predicate ignores it.
        store.recall("first");
        store.recall("first");
        store.store({ content: "fourth row" }, 4);
        expect(store.get(first.id)).toBeNull(); // evicted by oldest updated_at
      } finally {
        store.close();
      }
    });
  });

  describe("dedup config validation", () => {
    it("rejects fts5Threshold > 1 at construction", () => {
      expect(
        () =>
          new MemoryStore({
            dbFile: join(tmp, "bad.sqlite"),
            maxEntries: 10,
            dedup: { enabled: true, fts5Threshold: 1.5 },
          }),
      ).toThrow(/fts5Threshold/);
    });

    it("rejects fts5Threshold < 0 at construction", () => {
      expect(
        () =>
          new MemoryStore({
            dbFile: join(tmp, "bad.sqlite"),
            maxEntries: 10,
            dedup: { enabled: true, fts5Threshold: -0.1 },
          }),
      ).toThrow(/fts5Threshold/);
    });
  });
});
