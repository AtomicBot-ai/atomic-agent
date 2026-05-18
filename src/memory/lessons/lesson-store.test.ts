import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import {
  LESSON_ACTIVATION_MAX_LENGTH,
  LESSON_PRINCIPLE_MAX_LENGTH,
  LessonStore,
  LessonValidationError,
} from "./lesson-store.js";

/**
 * Memory-v2 phase 5. `LessonStore` is the agent-facing read surface
 * and the consolidator's write surface for distilled lessons. Pins:
 *
 *   - CRUD + getById round-trip preserves shape.
 *   - BM25 recall ranks by activation/principle overlap.
 *   - `listIndex` exposes activation only (not principle).
 *   - `recall { id }` works for deprecated lessons (cross-phase
 *     invariant 9: archived items never deleted).
 *   - Validation rejects empty / oversized fields.
 *   - Metrics fire on create / deprecate.
 */

interface Harness {
  dir: string;
  store: LessonStore;
  events: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  dispose: () => void;
}

function makeHarness(now = 1_000_000): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-"));
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
  let clock = now;
  const store = new LessonStore({
    dbFile: join(dir, "memory.sqlite"),
    metrics,
    now: () => clock++,
  });
  return {
    dir,
    store,
    events,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("LessonStore", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("create + getById round-trips the full lesson shape", () => {
    const lesson = h.store.create({
      activation: "When debugging llama-server slot allocation",
      principle:
        "Check `default_generation_settings.n_ctx` before assuming a v1 slot id; the v2 server returns a different shape.",
      tags: ["llama", "debug"],
      parentIds: [11, 22, 33],
      workingDir: "/work/proj",
    });
    expect(lesson.id).toBeGreaterThan(0);
    expect(lesson.status).toBe("active");
    expect(lesson.successCount).toBe(0);
    expect(lesson.failureCount).toBe(0);
    expect(lesson.parentIds).toEqual([11, 22, 33]);

    const fetched = h.store.getById(lesson.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.activation).toBe(lesson.activation);
    expect(fetched?.principle).toBe(lesson.principle);
    expect(fetched?.tags).toEqual(["llama", "debug"]);
    expect(fetched?.workingDir).toBe("/work/proj");
    expect(fetched?.parentIds).toEqual([11, 22, 33]);
  });

  it("fires agent.memory.lessons.created on create()", () => {
    h.store.create({
      activation: "a",
      principle: "p",
      parentIds: [1, 2, 3],
    });
    const created = h.events.find(
      (e) => e.name === "agent.memory.lessons.created",
    );
    expect(created).toBeDefined();
    expect(created?.tags?.parent_count).toBe("3");
  });

  it("rejects empty activation / principle", () => {
    expect(() =>
      h.store.create({ activation: " ", principle: "p", parentIds: [1] }),
    ).toThrow(LessonValidationError);
    expect(() =>
      h.store.create({ activation: "a", principle: "", parentIds: [1] }),
    ).toThrow(LessonValidationError);
  });

  it("rejects oversized activation / principle", () => {
    expect(() =>
      h.store.create({
        activation: "x".repeat(LESSON_ACTIVATION_MAX_LENGTH + 1),
        principle: "p",
        parentIds: [1],
      }),
    ).toThrow(LessonValidationError);
    expect(() =>
      h.store.create({
        activation: "a",
        principle: "x".repeat(LESSON_PRINCIPLE_MAX_LENGTH + 1),
        parentIds: [1],
      }),
    ).toThrow(LessonValidationError);
  });

  it("rejects empty / invalid parentIds", () => {
    expect(() =>
      h.store.create({ activation: "a", principle: "p", parentIds: [] }),
    ).toThrow(LessonValidationError);
    expect(() =>
      h.store.create({ activation: "a", principle: "p", parentIds: [0, 1] }),
    ).toThrow(LessonValidationError);
    expect(() =>
      h.store.create({
        activation: "a",
        principle: "p",
        parentIds: [-1, 1],
      }),
    ).toThrow(LessonValidationError);
  });

  it("BM25 recall ranks the relevant lesson first", () => {
    h.store.create({
      activation: "When the user asks about pnpm packages",
      principle: "Always use pnpm install over npm install for this repo.",
      tags: ["tooling"],
      parentIds: [1],
    });
    h.store.create({
      activation: "When debugging flaky Playwright tests",
      principle: "Re-run with `headless: false` and watch for layout shifts.",
      tags: ["test"],
      parentIds: [2],
    });
    const hits = h.store.recall({ query: "pnpm packages", k: 2 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.activation.toLowerCase()).toContain("pnpm");
  });

  it("recall { query } returns [] for empty / whitespace queries", () => {
    h.store.create({
      activation: "a",
      principle: "p",
      parentIds: [1],
    });
    expect(h.store.recall({ query: "" })).toEqual([]);
    expect(h.store.recall({ query: "   " })).toEqual([]);
  });

  it("recall { query } excludes deprecated lessons by default", () => {
    const active = h.store.create({
      activation: "When asked about pnpm",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    const deprecated = h.store.create({
      activation: "When asked about pnpm fallback",
      principle: "Fall back to pnpm exec.",
      parentIds: [2],
    });
    h.store.markDeprecated(deprecated.id, "test");
    const hits = h.store.recall({ query: "pnpm", k: 5 });
    expect(hits.map((l) => l.id)).toContain(active.id);
    expect(hits.map((l) => l.id)).not.toContain(deprecated.id);
  });

  it("recall { id } returns deprecated lessons (archived items still readable)", () => {
    const lesson = h.store.create({
      activation: "a",
      principle: "p",
      parentIds: [1],
    });
    h.store.markDeprecated(lesson.id);
    expect(h.store.recall({ id: lesson.id })[0]?.status).toBe("deprecated");
    expect(h.store.getById(lesson.id)?.status).toBe("deprecated");
  });

  it("listIndex exposes activation but not principle", () => {
    const lesson = h.store.create({
      activation: "Activation gist",
      principle: "Secret principle body",
      tags: ["alpha"],
      parentIds: [1],
    });
    const idx = h.store.listIndex();
    expect(idx).toHaveLength(1);
    expect(idx[0]?.id).toBe(lesson.id);
    expect(idx[0]?.activation).toBe("Activation gist");
    expect(idx[0]?.tags).toEqual(["alpha"]);
    // The pointer view never carries `principle` — sanity-check the
    // shape is strictly the LessonIndexEntry type.
    expect(idx[0]).not.toHaveProperty("principle");
  });

  it("listIndex skips deprecated lessons", () => {
    h.store.create({ activation: "active", principle: "p", parentIds: [1] });
    const deprecated = h.store.create({
      activation: "deprecated",
      principle: "p",
      parentIds: [2],
    });
    h.store.markDeprecated(deprecated.id);
    const idx = h.store.listIndex();
    expect(idx.map((r) => r.activation)).toEqual(["active"]);
  });

  it("markDeprecated is idempotent and fires the metric only the first time", () => {
    const lesson = h.store.create({
      activation: "a",
      principle: "p",
      parentIds: [1],
    });
    expect(h.store.markDeprecated(lesson.id, "age")).toBe(true);
    expect(h.store.markDeprecated(lesson.id, "age")).toBe(false);
    const events = h.events.filter(
      (e) => e.name === "agent.memory.lessons.deprecated",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.reason).toBe("age");
  });

  it("bumpSuccess / bumpFailure increment counters by 1", () => {
    const lesson = h.store.create({
      activation: "a",
      principle: "p",
      parentIds: [1],
    });
    h.store.bumpSuccess(lesson.id);
    h.store.bumpSuccess(lesson.id);
    h.store.bumpFailure(lesson.id);
    const fetched = h.store.getById(lesson.id);
    expect(fetched?.successCount).toBe(2);
    expect(fetched?.failureCount).toBe(1);
  });

  it("pickOverflowForDeprecation respects maxEntries", () => {
    h.dispose();
    const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-cap-"));
    const store = new LessonStore({
      dbFile: join(dir, "memory.sqlite"),
      maxEntries: 2,
    });
    try {
      const a = store.create({
        activation: "a",
        principle: "p",
        parentIds: [1],
      });
      const b = store.create({
        activation: "b",
        principle: "p",
        parentIds: [2],
      });
      store.create({ activation: "c", principle: "p", parentIds: [3] });
      const toDemote = store.pickOverflowForDeprecation();
      expect(toDemote.length).toBe(1);
      // Oldest one is `a` (lowest id).
      expect(toDemote[0]).toBe(a.id);
      void b;
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getById returns null for unknown id", () => {
    expect(h.store.getById(9999)).toBeNull();
  });

  // Phase 6 — age-based deprecation predicate.
  it("pickAgeDeprecationCandidates picks active lessons with success_count==0 older than threshold", () => {
    h.dispose();
    const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-age-"));
    // Hand-roll clock so we can control created_at deterministically.
    let clock = 1_000_000;
    const store = new LessonStore({
      dbFile: join(dir, "memory.sqlite"),
      now: () => clock,
    });
    try {
      clock = 1_000_000;
      const old = store.create({
        activation: "old",
        principle: "p",
        parentIds: [1],
      });
      clock = 2_000_000;
      const young = store.create({
        activation: "young",
        principle: "p",
        parentIds: [2],
      });
      clock = 1_000_000;
      const usefulOld = store.create({
        activation: "usefulOld",
        principle: "p",
        parentIds: [3],
      });
      // Bump success on usefulOld so age picker should skip it.
      store.bumpSuccess(usefulOld.id);

      const now = 3_000_000;
      const candidates = store.pickAgeDeprecationCandidates({
        now,
        deprecationAgeMs: 500_000,
      });
      // `old` is past threshold (now - old.created_at = 2_000_000 > 500_000), success_count=0 → eligible.
      // `young` is within threshold (now - young.created_at = 1_000_000 > 500_000) — also old enough actually.
      // Re-check: now=3M, young.created=2M, age=1M > 500_000 → also eligible.
      // To exercise the threshold properly, set a tighter window.
      const tight = store.pickAgeDeprecationCandidates({
        now,
        deprecationAgeMs: 1_500_000,
      });
      // age >= 1.5M only matches `old` (age=2M); `young` age=1M is below threshold.
      expect(tight).toEqual([old.id]);
      // Loose threshold also excludes usefulOld (success_count>0).
      expect(candidates.sort()).toEqual([old.id, young.id].sort());
      expect(candidates).not.toContain(usefulOld.id);

      // Deprecate `old`, re-query — must drop because status != 'active'.
      store.markDeprecated(old.id, "aged_out");
      const after = store.pickAgeDeprecationCandidates({
        now,
        deprecationAgeMs: 1_500_000,
      });
      expect(after).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pickAgeDeprecationCandidates returns oldest first (deterministic FIFO order)", () => {
    h.dispose();
    const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-age2-"));
    let clock = 1_000_000;
    const store = new LessonStore({
      dbFile: join(dir, "memory.sqlite"),
      now: () => clock,
    });
    try {
      clock = 1_000_000;
      const a = store.create({ activation: "a", principle: "p", parentIds: [1] });
      clock = 1_100_000;
      const b = store.create({ activation: "b", principle: "p", parentIds: [2] });
      clock = 1_200_000;
      const c = store.create({ activation: "c", principle: "p", parentIds: [3] });
      const ids = store.pickAgeDeprecationCandidates({
        now: 5_000_000,
        deprecationAgeMs: 100_000,
      });
      expect(ids).toEqual([a.id, b.id, c.id]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pickAgeDeprecationCandidates honours limit", () => {
    h.dispose();
    const dir = mkdtempSync(join(tmpdir(), "atomic-lessons-age3-"));
    let clock = 1_000_000;
    const store = new LessonStore({
      dbFile: join(dir, "memory.sqlite"),
      now: () => clock,
    });
    try {
      for (let i = 0; i < 5; i++) {
        clock = 1_000_000 + i * 1000;
        store.create({
          activation: `a${i}`,
          principle: "p",
          parentIds: [i + 1],
        });
      }
      const ids = store.pickAgeDeprecationCandidates({
        now: 9_000_000,
        deprecationAgeMs: 1000,
        limit: 2,
      });
      expect(ids.length).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
