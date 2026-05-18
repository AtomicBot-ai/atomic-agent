import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";
import { LinkStore } from "../links/link-store.js";
import { LessonStore } from "../lessons/lesson-store.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import { ConsolidatorJob } from "./consolidator-job.js";
import { DistillRunner } from "./distill-runner.js";

type Event = { name: string; value: number; tags?: Record<string, string> };

interface Harness {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  job: ConsolidatorJob;
  events: Event[];
  llmCalls: number;
  setNextLessonOutput: (raw: string) => void;
  dispose: () => void;
}

interface HarnessOptions {
  minClusterSize?: number;
  requireSharedTag?: boolean;
  maxClustersPerTick?: number;
  cooldownMs?: number;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-consolidator-"));
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  const linkStore = new LinkStore({
    db: memoryStore.getDatabaseHandleForEmbeddings(),
  });
  const events: Event[] = [];
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
  const lessonStore = new LessonStore({
    dbFile: join(dir, "memory.sqlite"),
    metrics,
  });
  let nextOutput = `LESSON activation="When working with pnpm"; principle="Use pnpm install over npm install."\n`;
  let llmCalls = 0;
  const distillRunner = new DistillRunner({
    llmComplete: async (_params) => {
      llmCalls += 1;
      return {
        content: nextOutput,
        reasoningContent: null,
        finishReason: "stop",
        usage: null,
      } as never;
    },
    slotId: -1,
    timeoutMs: 5000,
    metrics,
  });
  const job = new ConsolidatorJob(
    {
      enabled: true,
      intervalMs: 60_000,
      cooldownMs: opts.cooldownMs ?? 0,
      minClusterSize: opts.minClusterSize ?? 3,
      maxClustersPerTick: opts.maxClustersPerTick ?? 5,
      requireSharedTag: opts.requireSharedTag ?? false,
      consolidationLeaseMs: 60_000,
    },
    {
      memoryStore,
      linkStore,
      lessonStore,
      distillRunner,
      metrics,
    },
  );
  return {
    memoryStore,
    linkStore,
    lessonStore,
    job,
    events,
    get llmCalls() {
      return llmCalls;
    },
    setNextLessonOutput: (raw) => {
      nextOutput = raw;
    },
    dispose: () => {
      lessonStore.close();
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  } as Harness;
}

// Phase 6 — dedicated fixture with injectable clock and metrics wired
// into BOTH the lessonStore (so `markDeprecated` fires the metric)
// AND the job. Keeps the phase-6 sweep tests self-contained without
// the layered re-harness dance the phase-5 tests use.
interface Phase6Fixture {
  job: ConsolidatorJob;
  lessonStore: LessonStore;
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  events: Event[];
  clock: number;
  dispose: () => void;
}

function makePhase6Fixture(opts: {
  deprecationAgeMs: number;
  maxEntries: number;
  maxDeprecationsPerTick?: number;
}): Phase6Fixture {
  const dir = mkdtempSync(join(tmpdir(), "atomic-consolidator-p6-"));
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  const linkStore = new LinkStore({
    db: memoryStore.getDatabaseHandleForEmbeddings(),
  });
  const events: Event[] = [];
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
  // Closure-captured clock; tests mutate `fixture.clock` directly.
  // The LessonStore + the job share the **same** clock so `created_at`
  // and `now - deprecationAgeMs` line up deterministically.
  const fixture: Partial<Phase6Fixture> & { clock: number } = {
    clock: 1_000_000,
  };
  const clock = () => fixture.clock;
  const lessonStore = new LessonStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: opts.maxEntries,
    metrics,
    now: clock,
  });
  const distill = new DistillRunner({
    llmComplete: async () =>
      ({
        content: `LESSON activation="x"; principle="y"\n`,
        reasoningContent: null,
        finishReason: "stop",
        usage: null,
      }) as never,
    slotId: -1,
    timeoutMs: 5000,
  });
  const job = new ConsolidatorJob(
    {
      enabled: true,
      intervalMs: 60_000,
      cooldownMs: 0,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: false,
      consolidationLeaseMs: 60_000,
      deprecationAgeMs: opts.deprecationAgeMs,
      maxDeprecationsPerTick: opts.maxDeprecationsPerTick ?? 100,
    },
    {
      memoryStore,
      linkStore,
      lessonStore,
      distillRunner: distill,
      metrics,
      now: clock,
    },
  );
  fixture.job = job;
  fixture.lessonStore = lessonStore;
  fixture.memoryStore = memoryStore;
  fixture.linkStore = linkStore;
  fixture.events = events;
  fixture.dispose = () => {
    lessonStore.close();
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return fixture as Phase6Fixture;
}

describe("ConsolidatorJob (phase 5, scenario 5.A)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("returns 'none' when there are no candidates", async () => {
    const result = await h.job.runOnce();
    expect(result).toMatchObject({
      outcome: "none",
      clustersConsidered: 0,
      lessonsCreated: 0,
    });
  });

  it("promotes a 3-episode CC into one lesson and archives parents (5.A.1, 5.A.2, 5.A.3, 5.A.5, 5.A.8)", async () => {
    const a = h.memoryStore.store({ content: "note A pnpm", source: "agent" });
    const b = h.memoryStore.store({ content: "note B pnpm", source: "agent" });
    const c = h.memoryStore.store({ content: "note C pnpm", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const result = await h.job.runOnce();
    expect(result.outcome).toBe("ok");
    expect(result.clustersConsidered).toBe(1);
    expect(result.lessonsCreated).toBe(1);
    expect(h.llmCalls).toBe(1);

    // 5.A.1 — one new lesson with non-empty activation & principle.
    const lessons = h.lessonStore.listIndex();
    expect(lessons).toHaveLength(1);
    const lessonId = lessons[0]!.id;
    const lesson = h.lessonStore.getById(lessonId)!;
    expect(lesson.activation).toContain("pnpm");
    expect(lesson.principle).toContain("pnpm");

    // 5.A.2 — parent_ids is a JSON array of the 3 episode ids.
    expect(lesson.parentIds.sort()).toEqual([a.id, b.id, c.id]);

    // 5.A.3 — all 3 episodes get consolidated_into = lessonId.
    expect(h.memoryStore.getConsolidatedInto(a.id)).toBe(lessonId);
    expect(h.memoryStore.getConsolidatedInto(b.id)).toBe(lessonId);
    expect(h.memoryStore.getConsolidatedInto(c.id)).toBe(lessonId);

    // 5.A.4 — archived parents are still readable by id.
    expect(h.memoryStore.get(a.id)?.content).toBe("note A pnpm");

    // 5.A.5 — archived parents drop from listIndex / excludeArchived.
    const idx = h.memoryStore.listIndex({ excludeArchived: true });
    expect(idx.map((r) => r.id)).not.toContain(a.id);
    expect(idx.map((r) => r.id)).not.toContain(b.id);
    expect(idx.map((r) => r.id)).not.toContain(c.id);

    // 5.A.8 — metric agent.memory.lessons.created ≥ 1.
    const created = h.events.find(
      (e) => e.name === "agent.memory.lessons.created",
    );
    expect(created).toBeDefined();
  });

  it("treats abstain output as 'none' and does not write a lesson", async () => {
    h.setNextLessonOutput(
      `LESSON activation="(no consensus)"; principle="(no durable advice)"\n`,
    );
    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const result = await h.job.runOnce();
    expect(result.outcome).toBe("none");
    expect(result.lessonsCreated).toBe(0);
    expect(result.lessonsAbstained).toBe(1);
    expect(h.lessonStore.countAll()).toBe(0);
    // Parents stay active — abstain ≠ archive.
    expect(h.memoryStore.getConsolidatedInto(a.id)).toBeNull();
  });

  it("isolates per-cluster failures and lets a second cluster succeed", async () => {
    // Force the LLM to throw on the first call only.
    let callCount = 0;
    const failingRunner = new DistillRunner({
      llmComplete: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("simulated llm failure");
        }
        return {
          content: `LESSON activation="x"; principle="y"\n`,
          reasoningContent: null,
          finishReason: "stop",
          usage: null,
        } as never;
      },
      slotId: -1,
      timeoutMs: 5_000,
    });
    const collector = new MetricsCollector({ sinks: [] });
    const metrics = new AgentMetrics(collector);
    const job = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        minClusterSize: 3,
        maxClustersPerTick: 5,
        requireSharedTag: false,
        consolidationLeaseMs: 60_000,
      },
      {
        memoryStore: h.memoryStore,
        linkStore: h.linkStore,
        lessonStore: h.lessonStore,
        distillRunner: failingRunner,
        metrics,
      },
    );

    // Cluster 1: a, b, c.
    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });
    // Cluster 2: d, e, f.
    const d = h.memoryStore.store({ content: "note D", source: "agent" });
    const e = h.memoryStore.store({ content: "note E", source: "agent" });
    const f = h.memoryStore.store({ content: "note F", source: "agent" });
    h.linkStore.add({ fromId: d.id, toId: e.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: e.id, toId: f.id, kind: "RELATES_TO" });

    const result = await job.runOnce();
    expect(result.clustersConsidered).toBe(2);
    expect(result.lessonsCreated).toBe(1);
    expect(result.failures).toBe(1);
    // Outcome is "ok" because at least one lesson landed.
    expect(result.outcome).toBe("ok");
  });

  it("is idempotent on a second tick (archived rows excluded from new candidates)", async () => {
    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const r1 = await h.job.runOnce();
    expect(r1.lessonsCreated).toBe(1);
    const r2 = await h.job.runOnce();
    expect(r2).toMatchObject({
      outcome: "none",
      clustersConsidered: 0,
      lessonsCreated: 0,
    });
  });

  it("respects cooldownMs — episodes younger than cooldown are not eligible", async () => {
    // Build a fresh harness with a cooldown of 1h.
    h.dispose();
    h = makeHarness({ cooldownMs: 3_600_000 });

    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const result = await h.job.runOnce();
    expect(result.outcome).toBe("none");
    expect(result.clustersConsidered).toBe(0);
  });

  it("emits agent.memory.consolidation.run with the right outcome tag", async () => {
    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });
    await h.job.runOnce();
    const run = h.events.find(
      (e) => e.name === "agent.memory.consolidation.run",
    );
    expect(run).toBeDefined();
    expect(run?.tags?.outcome).toBe("ok");
  });

  // Phase 6 — scenario 6.A.1 / 6.A.6: aged-out lessons with
  // success_count==0 get demoted to `deprecated` and the metric
  // fires with reason=aged_out.
  it("deprecation sweep demotes aged-out lessons with success_count=0 and fires the metric", async () => {
    h.dispose();
    const fixture = makePhase6Fixture({
      deprecationAgeMs: 1000,
      maxEntries: 100,
    });
    try {
      // Both rows created at clock=T0, success_count=0/1. The job
      // ticks at clock=T0+5000, so age=5000 > 1000 — both are
      // eligible by age. Bumping success on `b` saves it.
      fixture.clock = 1_000_000;
      const a = fixture.lessonStore.create({
        activation: "old useless",
        principle: "p",
        parentIds: [1, 2, 3],
      });
      const b = fixture.lessonStore.create({
        activation: "old useful",
        principle: "p",
        parentIds: [4, 5, 6],
      });
      fixture.lessonStore.bumpSuccess(b.id);
      fixture.clock = 1_005_000;
      const result = await fixture.job.runOnce();
      expect(result.lessonsDeprecatedByAge).toBe(1);
      expect(fixture.lessonStore.getById(a.id)?.status).toBe("deprecated");
      expect(fixture.lessonStore.getById(b.id)?.status).toBe("active");
      const dep = fixture.events.find(
        (e) => e.name === "agent.memory.lessons.deprecated",
      );
      expect(dep).toBeDefined();
      expect(dep?.tags?.reason).toBe("aged_out");
    } finally {
      fixture.dispose();
    }
  });

  // Phase 6 — scorecard 6.A.4: deprecated lessons remain readable by id.
  it("deprecated lessons are excluded from recall but still readable by id", async () => {
    const a = h.lessonStore.create({
      activation: "needle exact match",
      principle: "principle a",
      parentIds: [1, 2, 3],
    });
    h.lessonStore.markDeprecated(a.id, "aged_out");
    // BM25 recall (active-only by default) drops the deprecated row.
    expect(h.lessonStore.recall({ query: "needle" }).map((l) => l.id)).not.toContain(
      a.id,
    );
    // `getById` returns it regardless of status.
    expect(h.lessonStore.getById(a.id)?.status).toBe("deprecated");
  });

  // Phase 6 — `maxEntries` FIFO eviction (bounded total).
  it("overflow sweep demotes oldest active lessons by updated_at FIFO and fires the metric", async () => {
    h.dispose();
    const fixture = makePhase6Fixture({
      deprecationAgeMs: 0,
      maxEntries: 2,
    });
    try {
      fixture.clock = 1_000;
      const oldest = fixture.lessonStore.create({
        activation: "oldest",
        principle: "p",
        parentIds: [1],
      });
      fixture.clock = 2_000;
      const middle = fixture.lessonStore.create({
        activation: "middle",
        principle: "p",
        parentIds: [2],
      });
      fixture.clock = 3_000;
      const newest = fixture.lessonStore.create({
        activation: "newest",
        principle: "p",
        parentIds: [3],
      });
      fixture.lessonStore.bumpSuccess(oldest.id);
      fixture.lessonStore.bumpSuccess(middle.id);
      fixture.lessonStore.bumpSuccess(newest.id);
      fixture.clock = 9_000;
      const result = await fixture.job.runOnce();
      expect(result.lessonsDeprecatedByOverflow).toBe(1);
      expect(fixture.lessonStore.getById(oldest.id)?.status).toBe("deprecated");
      expect(fixture.lessonStore.countActive()).toBe(2);
      const overflow = fixture.events.find(
        (e) =>
          e.name === "agent.memory.lessons.deprecated" &&
          e.tags?.reason === "overflow",
      );
      expect(overflow).toBeDefined();
    } finally {
      fixture.dispose();
    }
  });

  // Phase 6 — combined cap.
  it("sweep respects maxDeprecationsPerTick across both passes", async () => {
    h.dispose();
    const fixture = makePhase6Fixture({
      deprecationAgeMs: 0,
      maxEntries: 1,
      maxDeprecationsPerTick: 1,
    });
    try {
      for (let i = 0; i < 5; i++) {
        fixture.clock = 1_000 + i;
        const l = fixture.lessonStore.create({
          activation: `a${i}`,
          principle: "p",
          parentIds: [i + 1],
        });
        fixture.lessonStore.bumpSuccess(l.id);
      }
      fixture.clock = 100_000;
      const result = await fixture.job.runOnce();
      const total =
        result.lessonsDeprecatedByAge + result.lessonsDeprecatedByOverflow;
      expect(total).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  // Phase 6 — scorecard 6.A.4: deprecated lessons remain readable by id.
  it("deprecated lessons are excluded from recall but still readable by id", async () => {
    const a = h.lessonStore.create({
      activation: "needle exact match",
      principle: "principle a",
      parentIds: [1, 2, 3],
    });
    h.lessonStore.markDeprecated(a.id, "aged_out");
    expect(
      h.lessonStore.recall({ query: "needle" }).map((l) => l.id),
    ).not.toContain(a.id);
    expect(h.lessonStore.getById(a.id)?.status).toBe("deprecated");
  });

  // Phase 6 — scorecard 6.A.5: `lesson_deprecated` event fires once
  // per demoted lesson with the right reason.
  it("emits onLessonDeprecated for every demoted lesson (age + overflow)", async () => {
    h.dispose();
    const events: Array<{ lessonId: number; reason: string }> = [];
    const baseFixture = makePhase6Fixture({
      deprecationAgeMs: 100,
      maxEntries: 1,
    });
    try {
      // Replace the job with one that has the callback wired. The
      // shared fixture builds the job without the callback by
      // default; we recreate it cheaply over the same stores.
      const customJob = new ConsolidatorJob(
        {
          enabled: true,
          intervalMs: 60_000,
          cooldownMs: 0,
          minClusterSize: 3,
          maxClustersPerTick: 5,
          requireSharedTag: false,
          consolidationLeaseMs: 60_000,
          deprecationAgeMs: 100,
          maxDeprecationsPerTick: 100,
        },
        {
          memoryStore: baseFixture.memoryStore,
          linkStore: baseFixture.linkStore,
          lessonStore: baseFixture.lessonStore,
          distillRunner: new DistillRunner({
            llmComplete: async () =>
              ({
                content: `LESSON activation="x"; principle="y"\n`,
                reasoningContent: null,
                finishReason: "stop",
                usage: null,
              }) as never,
            slotId: -1,
            timeoutMs: 5_000,
          }),
          now: () => baseFixture.clock,
          onLessonDeprecated: (e) => events.push(e),
        },
      );
      baseFixture.clock = 1_000;
      const aged = baseFixture.lessonStore.create({
        activation: "aged",
        principle: "p",
        parentIds: [1],
      });
      // Two successful survivors — after the age sweep demotes
      // `aged`, the FIFO sweep with maxEntries=1 still demotes the
      // oldest of the two surviving rows.
      const survivor1 = baseFixture.lessonStore.create({
        activation: "survivor1",
        principle: "p",
        parentIds: [2],
      });
      baseFixture.lessonStore.bumpSuccess(survivor1.id);
      baseFixture.clock = 1_500;
      const survivor2 = baseFixture.lessonStore.create({
        activation: "survivor2",
        principle: "p",
        parentIds: [3],
      });
      baseFixture.lessonStore.bumpSuccess(survivor2.id);
      baseFixture.clock = 2_000;
      await customJob.runOnce();
      const byLesson = new Map(events.map((e) => [e.lessonId, e.reason]));
      expect(byLesson.get(aged.id)).toBe("aged_out");
      // The older of the two survivors is `survivor1`.
      expect(byLesson.get(survivor1.id)).toBe("overflow");
      expect(byLesson.has(survivor2.id)).toBe(false);
    } finally {
      baseFixture.dispose();
    }
  });

  // Phase 6 — sweep runs even on a "none" tick (no clusters formed).
  it("deprecation sweep runs on every tick, including when no clusters form", async () => {
    h.dispose();
    const fixture = makePhase6Fixture({
      deprecationAgeMs: 100,
      maxEntries: 100,
    });
    try {
      fixture.clock = 1_000;
      const a = fixture.lessonStore.create({
        activation: "stale",
        principle: "p",
        parentIds: [1],
      });
      // Move the clock past the threshold.
      fixture.clock = 2_000;
      // No memories in the store → distillation returns "none".
      const result = await fixture.job.runOnce();
      expect(result.outcome).toBe("none");
      expect(result.lessonsDeprecatedByAge).toBe(1);
      expect(fixture.lessonStore.getById(a.id)?.status).toBe("deprecated");
    } finally {
      fixture.dispose();
    }
  });

  it("re-entry guard returns a zero-summary when another tick is in flight", async () => {
    const a = h.memoryStore.store({ content: "note A", source: "agent" });
    const b = h.memoryStore.store({ content: "note B", source: "agent" });
    const c = h.memoryStore.store({ content: "note C", source: "agent" });
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });
    const [r1, r2] = await Promise.all([
      h.job.runOnce(),
      h.job.runOnce(),
    ]);
    // Exactly one tick does the work; the other returns the zero
    // summary thanks to the `running` guard.
    const totalCreated =
      (r1.lessonsCreated ?? 0) + (r2.lessonsCreated ?? 0);
    expect(totalCreated).toBe(1);
  });
});
