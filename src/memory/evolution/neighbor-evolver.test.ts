import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import { MemoryStore } from "../memory-store.js";
import { NeighborEvolver } from "./neighbor-evolver.js";

interface MetricEntry {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

interface Harness {
  dir: string;
  store: MemoryStore;
  metrics: AgentMetrics;
  events: MetricEntry[];
  dispose: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-evolver-"));
  const store = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  const events: MetricEntry[] = [];
  const collector = new MetricsCollector({
    sinks: [
      (e) =>
        events.push({
          name: e.name,
          value: e.value,
          tags: e.tags as Record<string, string> | undefined,
        }),
    ],
  });
  const metrics = new AgentMetrics(collector);
  return {
    dir,
    store,
    metrics,
    events,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("NeighborEvolver", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("scenario 3.A — applies tag enrichment without touching content", () => {
    const seeded = h.store.store({
      content: "playwright is the browser backend",
      tags: ["browser"],
    });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [
        { targetId: seeded.id, addTags: ["playwright", "selectors"] },
      ],
    });
    expect(report.applied).toBe(1);
    const after = h.store.get(seeded.id);
    expect(after).not.toBeNull();
    expect(after?.content).toBe("playwright is the browser backend");
    expect(after?.tags).toEqual(["browser", "playwright", "selectors"]);
    const applied = h.events.find(
      (e) => e.name === "agent.memory.evolution.applied",
    );
    expect(applied).toBeDefined();
  });

  it("scenario 3.B — skips when consolidation lease is held", () => {
    const seeded = h.store.store({
      content: "active note",
      tags: ["alpha"],
    });
    // Simulate an active consolidator: stamp the lease.
    const ok = h.store.acquireConsolidationLease(seeded.id, 60_000);
    expect(ok).toBe(true);
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      leaseMs: 60_000,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [{ targetId: seeded.id, addTags: ["beta"] }],
    });
    expect(report.applied).toBe(0);
    expect(report.skipped.skipped_lease_held).toBe(1);
    const after = h.store.get(seeded.id);
    expect(after?.tags).toEqual(["alpha"]); // unchanged
    const skipped = h.events.find(
      (e) =>
        e.name === "agent.memory.evolution.skipped" &&
        e.tags?.reason === "lease_held",
    );
    expect(skipped).toBeDefined();
  });

  it("invariant 5 — content byte-stable across N evolve calls", () => {
    const original = "the canonical playwright primer content body";
    const seeded = h.store.store({
      content: original,
      tags: ["seed"],
    });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      maxPerWrite: 1,
    });
    for (let i = 0; i < 25; i += 1) {
      evolver.apply({
        sessionId: "s1",
        evolves: [
          { targetId: seeded.id, addTags: [`tag_${i}`] },
        ],
      });
    }
    const after = h.store.get(seeded.id);
    expect(after?.content).toBe(original);
  });

  it("respects maxPerWrite cap, counting the rest as cap_hit", () => {
    const a = h.store.store({ content: "a" });
    const b = h.store.store({ content: "b" });
    const c = h.store.store({ content: "c" });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      maxPerWrite: 1,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [
        { targetId: a.id, addTags: ["x"] },
        { targetId: b.id, addTags: ["y"] },
        { targetId: c.id, addTags: ["z"] },
      ],
    });
    expect(report.applied).toBe(1);
    expect(report.skipped.skipped_cap_hit).toBe(2);
    const capHit = h.events.find(
      (e) =>
        e.name === "agent.memory.evolution.skipped" &&
        e.tags?.reason === "cap_hit",
    );
    expect(capHit).toBeDefined();
  });

  it("filters by allowlist when provided", () => {
    const a = h.store.store({ content: "a" });
    const b = h.store.store({ content: "b" });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [
        { targetId: a.id, addTags: ["x"] },
        { targetId: b.id, addTags: ["y"] },
      ],
      allowlist: new Set([a.id]),
    });
    expect(report.applied).toBe(1);
    expect(report.skipped.skipped_not_in_allowlist).toBe(1);
  });

  it("returns missing when the target id no longer exists", () => {
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [{ targetId: 99999, addTags: ["x"] }],
    });
    expect(report.skipped.skipped_missing).toBe(1);
  });

  it("skips when every proposed tag is already present (no_change)", () => {
    const seeded = h.store.store({
      content: "already-tagged note",
      tags: ["alpha", "beta"],
    });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      metrics: h.metrics,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [{ targetId: seeded.id, addTags: ["alpha"] }],
    });
    expect(report.applied).toBe(0);
    expect(report.skipped.skipped_no_change).toBe(1);
  });

  it("lease expiry allows the evolve through", () => {
    const seeded = h.store.store({ content: "x", tags: ["a"] });
    // Stamp a stale lease (well outside the window).
    h.store.acquireConsolidationLease(seeded.id, 60_000, 0);
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      leaseMs: 60_000,
      now: () => 10_000_000,
    });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [{ targetId: seeded.id, addTags: ["b"] }],
    });
    expect(report.applied).toBe(1);
    const after = h.store.get(seeded.id);
    expect(after?.tags).toEqual(["a", "b"]);
  });

  it("empty evolves yields empty report", () => {
    const evolver = new NeighborEvolver({ memoryStore: h.store });
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [],
    });
    expect(report.applied).toBe(0);
    expect(report.totalProposed).toBe(0);
  });

  it("invalid tag list throws via the store, surfaced as skipped_invalid", () => {
    const seeded = h.store.store({ content: "x" });
    const evolver = new NeighborEvolver({
      memoryStore: h.store,
      metrics: h.metrics,
    });
    // empty addTags would be rejected by parser but the store guards
    // independently — simulate that path by going through `applyOne`
    // with a hand-crafted directive.
    const report = evolver.apply({
      sessionId: "s1",
      evolves: [{ targetId: seeded.id, addTags: [] }],
    });
    expect(report.skipped.skipped_invalid).toBe(1);
  });
});
