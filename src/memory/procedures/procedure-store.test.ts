import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import {
  ProcedureStore,
  ProcedureValidationError,
  computeProcedureCombinedScore,
  PROCEDURE_ACTIVATION_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
} from "./procedure-store.js";

interface Harness {
  dir: string;
  store: ProcedureStore;
  events: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  dispose: () => void;
  setClock: (next: number) => void;
}

function makeHarness(initialNow = 1_000_000, maxEntries?: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-procedures-"));
  const events: Harness["events"] = [];
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
  let clock = initialNow;
  const store = new ProcedureStore({
    dbFile: join(dir, "memory.sqlite"),
    metrics,
    maxEntries,
    now: () => clock++,
  });
  return {
    dir,
    store,
    events,
    setClock: (next: number) => {
      clock = next;
    },
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("ProcedureStore", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.dispose();
  });

  it("creates a procedure and round-trips it via getById", () => {
    const created = h.store.create({
      activation: "extract function signatures",
      steps: [
        { description: "glob TypeScript files", toolHint: "os.fs.glob" },
        { description: "grep for export", toolHint: "os.fs.grep" },
      ],
      tags: ["typescript", "code-search"],
      parentLessonIds: [10],
      parentMemoryIds: [1, 2, 3, 4],
      workingDir: "/tmp/proj",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe("active");
    expect(created.source).toBe("consolidator");
    expect(created.useCount).toBe(0);
    expect(created.voteScore).toBe(0);
    expect(created.steps).toHaveLength(2);
    expect(created.steps[0]).toEqual({
      description: "glob TypeScript files",
      toolHint: "os.fs.glob",
    });
    const fetched = h.store.getById(created.id);
    expect(fetched).toMatchObject({
      id: created.id,
      activation: created.activation,
      tags: ["typescript", "code-search"],
      parentLessonIds: [10],
      parentMemoryIds: [1, 2, 3, 4],
      workingDir: "/tmp/proj",
    });
  });

  it("rejects steps below min count", () => {
    expect(() =>
      h.store.create({
        activation: "x",
        steps: [{ description: "only one", toolHint: null }],
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(ProcedureValidationError);
  });

  it("rejects steps above max count", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      description: `step ${i}`,
      toolHint: null,
    }));
    expect(() =>
      h.store.create({
        activation: "x",
        steps: tooMany,
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(/at most/);
  });

  it("rejects empty activation", () => {
    expect(() =>
      h.store.create({
        activation: "   ",
        steps: [
          { description: "a", toolHint: null },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(/non-empty/);
  });

  it("rejects oversized activation", () => {
    expect(() =>
      h.store.create({
        activation: "x".repeat(PROCEDURE_ACTIVATION_MAX_LENGTH + 1),
        steps: [
          { description: "a", toolHint: null },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(/at most/);
  });

  it("rejects oversized step description", () => {
    expect(() =>
      h.store.create({
        activation: "x",
        steps: [
          {
            description: "y".repeat(PROCEDURE_DESCRIPTION_MAX_LENGTH + 1),
            toolHint: null,
          },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(/description must be at most/);
  });

  it("rejects malformed toolHint", () => {
    expect(() =>
      h.store.create({
        activation: "x",
        steps: [
          { description: "a", toolHint: "bad hint with spaces!" },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [1],
        parentMemoryIds: [1],
      }),
    ).toThrow(/toolHint must match/);
  });

  it("rejects empty parent lists", () => {
    expect(() =>
      h.store.create({
        activation: "x",
        steps: [
          { description: "a", toolHint: null },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [],
        parentMemoryIds: [1],
      }),
    ).toThrow(/parentLessonIds/);
    expect(() =>
      h.store.create({
        activation: "x",
        steps: [
          { description: "a", toolHint: null },
          { description: "b", toolHint: null },
        ],
        parentLessonIds: [1],
        parentMemoryIds: [],
      }),
    ).toThrow(/parentMemoryIds/);
  });

  it("recall by BM25 query returns matching active rows", () => {
    h.store.create({
      activation: "extract typescript function signatures",
      steps: [
        { description: "glob ts", toolHint: "os.fs.glob" },
        { description: "grep export", toolHint: "os.fs.grep" },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store.create({
      activation: "summarise python module",
      steps: [
        { description: "read", toolHint: "os.fs.read" },
        { description: "summarise", toolHint: null },
      ],
      parentLessonIds: [2],
      parentMemoryIds: [2],
    });
    const hits = h.store.recall({ query: "typescript signatures", k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].activation).toContain("typescript");
  });

  it("recall by id returns deprecated procedures", () => {
    const created = h.store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    expect(h.store.markDeprecated(created.id, "test")).toBe(true);
    const hits = h.store.recall({ id: created.id });
    expect(hits).toHaveLength(1);
    expect(hits[0].status).toBe("deprecated");
  });

  it("recall by query excludes deprecated rows by default", () => {
    const created = h.store.create({
      activation: "extract typescript",
      steps: [
        { description: "glob", toolHint: "os.fs.glob" },
        { description: "grep", toolHint: "os.fs.grep" },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store.markDeprecated(created.id, "test");
    expect(h.store.recall({ query: "typescript" })).toEqual([]);
    expect(
      h.store.recall({ query: "typescript", includeDeprecated: true }),
    ).toHaveLength(1);
  });

  it("bumpUse / bumpSuccess / bumpFailure update counters", () => {
    const created = h.store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store.bumpUse(created.id);
    h.store.bumpUse(created.id);
    h.store.bumpSuccess(created.id);
    h.store.bumpFailure(created.id);
    const fetched = h.store.getById(created.id);
    expect(fetched).toMatchObject({
      useCount: 2,
      successCount: 1,
      failureCount: 1,
    });
  });

  it("cascade deprecation by parent lesson", () => {
    const a = h.store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [42],
      parentMemoryIds: [1],
    });
    const b = h.store.create({
      activation: "y",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [42, 99],
      parentMemoryIds: [2],
    });
    const orphan = h.store.create({
      activation: "z",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [100],
      parentMemoryIds: [3],
    });
    const flipped = h.store.deprecateByParentLesson(42, "cascade");
    expect(flipped.sort()).toEqual([a.id, b.id].sort());
    expect(h.store.getById(a.id)!.status).toBe("deprecated");
    expect(h.store.getById(b.id)!.status).toBe("deprecated");
    expect(h.store.getById(orphan.id)!.status).toBe("active");
  });

  it("listIndex omits steps body and orders by vote_score DESC", () => {
    const lo = h.store.create({
      activation: "low vote",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    const hi = h.store.create({
      activation: "high vote",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = 5.0 WHERE id = ?`)
      .run(hi.id);
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = -1.0 WHERE id = ?`)
      .run(lo.id);
    const entries = h.store.listIndex({ limit: 10 });
    expect(entries[0].id).toBe(hi.id);
    expect(entries[entries.length - 1].id).toBe(lo.id);
    expect(entries[0]).not.toHaveProperty("steps");
  });

  it("pickAgeDeprecationCandidates honours dormancy", () => {
    h.setClock(1000);
    const fresh = h.store.create({
      activation: "fresh",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.setClock(1_000_000);
    const stale = h.store.create({
      activation: "stale",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store.bumpUse(stale.id);
    h.setClock(10_000_000);
    const ids = h.store.pickAgeDeprecationCandidates({
      now: 10_000_000,
      deprecationAgeMs: 1_000_000,
    });
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });

  it("pickVoteDeprecationCandidates picks most-negative first", () => {
    const a = h.store.create({
      activation: "a",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    const b = h.store.create({
      activation: "b",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = -3 WHERE id = ?`)
      .run(b.id);
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = -1 WHERE id = ?`)
      .run(a.id);
    expect(h.store.pickVoteDeprecationCandidates()).toEqual([b.id, a.id]);
  });

  it("pickOverflowForDeprecation orders by vote_score then updated_at", () => {
    h = makeHarness(1_000_000, 1);
    const old = h.store.create({
      activation: "old",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    const young = h.store.create({
      activation: "young",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = 0 WHERE id = ?`)
      .run(young.id);
    h.store["db"]
      .prepare(`UPDATE procedures SET vote_score = -5 WHERE id = ?`)
      .run(old.id);
    const overflow = h.store.pickOverflowForDeprecation();
    expect(overflow).toEqual([old.id]);
  });

  it("emits procedure_created metric on create", () => {
    h.store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [10, 11],
      parentMemoryIds: [1, 2, 3],
    });
    const created = h.events.find(
      (e) => e.name === "agent.memory.procedures.created",
    );
    expect(created).toBeDefined();
    expect(created!.tags).toMatchObject({
      source: "consolidator",
      parent_lesson_count: "2",
      parent_memory_count: "3",
    });
  });

  it("emits procedure_deprecated metric with reason tag", () => {
    const created = h.store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    h.store.markDeprecated(created.id, "cascade");
    const dep = h.events.find(
      (e) => e.name === "agent.memory.procedures.deprecated",
    );
    expect(dep).toBeDefined();
    expect(dep!.tags).toMatchObject({ reason: "cascade" });
  });

  it("computeProcedureCombinedScore blends vote and counters", () => {
    const proc = { voteScore: 4, successCount: 2, failureCount: 1 };
    expect(computeProcedureCombinedScore(proc, 0)).toBe(1);
    expect(computeProcedureCombinedScore(proc, 1)).toBe(4);
    expect(computeProcedureCombinedScore(proc, 0.5)).toBe(2.5);
  });
});
