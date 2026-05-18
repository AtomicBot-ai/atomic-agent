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
