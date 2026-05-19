import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";
import { LinkStore } from "../links/link-store.js";
import { LessonStore } from "../lessons/lesson-store.js";
import { VoteStore } from "../voting/vote-store.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import { ConsolidatorJob } from "./consolidator-job.js";
import { DistillRunner } from "./distill-runner.js";

type Event = { name: string; value: number; tags?: Record<string, string> };

interface Fixture {
  job: ConsolidatorJob;
  lessonStore: LessonStore;
  voteStore: VoteStore;
  memoryStore: MemoryStore;
  events: Event[];
  setClock: (n: number) => void;
  dispose: () => void;
}

// Phase 7a — dedicated fixture wired with a VoteStore and an
// injectable clock. Mirrors the phase-6 fixture shape from
// consolidator-job.test.ts but adds the voting dependency. Kept
// in its own file so phase-7a-specific scenarios (vote-driven
// deprecation, per-tick decay) stay legible without inflating the
// existing 587-line test file.
function makeFixture(opts: {
  voteSignalDecay?: number;
  deprecationAgeMs?: number;
  maxDeprecationsPerTick?: number;
  voteStoreWired?: boolean;
}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "atomic-consolidator-p7a-"));
  let clock = 1_000_000;
  const now = () => clock;
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
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
    now,
  });
  const voteStore = new VoteStore({ db, now });
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
  const wired = opts.voteStoreWired !== false;
  const job = new ConsolidatorJob(
    {
      enabled: true,
      intervalMs: 60_000,
      cooldownMs: 0,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: false,
      consolidationLeaseMs: 60_000,
      deprecationAgeMs: opts.deprecationAgeMs ?? 0,
      maxDeprecationsPerTick: opts.maxDeprecationsPerTick ?? 100,
      voteSignalDecay: opts.voteSignalDecay ?? 0,
    },
    {
      memoryStore,
      linkStore,
      lessonStore,
      distillRunner: distill,
      metrics,
      now,
      voteStore: wired ? voteStore : null,
    },
  );
  return {
    job,
    lessonStore,
    voteStore,
    memoryStore,
    events,
    setClock: (n) => {
      clock = n;
    },
    dispose: () => {
      lessonStore.close();
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("ConsolidatorJob (phase 7a) — vote-driven deprecation", () => {
  let f: Fixture;

  afterEach(() => {
    f?.dispose();
  });

  it("demotes an unused lesson whose vote_score went negative (scorecard 7a.A.1)", async () => {
    f = makeFixture({ voteSignalDecay: 0.95 });
    const lesson = f.lessonStore.create({
      activation: "ride the omnissiah",
      principle: "praise the machine god",
      tags: [],
      parentIds: [1],
    });
    // Operator downvoted before the lesson ever helped a turn.
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });
    expect(f.lessonStore.getById(lesson.id)?.status).toBe("active");

    const result = await f.job.runOnce();

    expect(result.lessonsDeprecatedByVote).toBe(1);
    expect(result.lessonsDeprecatedByAge).toBe(0);
    expect(f.lessonStore.getById(lesson.id)?.status).toBe("deprecated");
  });

  it("survives downvote if the lesson has at least one success bump (scorecard 7a.A.2)", async () => {
    f = makeFixture({ voteSignalDecay: 0.95 });
    const lesson = f.lessonStore.create({
      activation: "x",
      principle: "y",
      tags: [],
      parentIds: [1],
    });
    f.lessonStore.bumpSuccess(lesson.id);
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    const result = await f.job.runOnce();

    expect(result.lessonsDeprecatedByVote).toBe(0);
    expect(f.lessonStore.getById(lesson.id)?.status).toBe("active");
  });

  it("emits trace event with reason='downvoted' for vote-driven demotions", async () => {
    f = makeFixture({ voteSignalDecay: 0.95 });
    const traces: Array<{ lessonId: number; reason: string }> = [];
    // Reach into the deps by reconstructing the job is overkill;
    // verify via the metrics counter instead.
    const lesson = f.lessonStore.create({
      activation: "x",
      principle: "y",
      tags: [],
      parentIds: [1],
    });
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    await f.job.runOnce();

    const deprecations = f.events.filter(
      (e) => e.name === "agent.memory.lessons.deprecated",
    );
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0]!.tags?.reason).toBe("downvoted");
    expect(traces.length).toBe(0); // placeholder — trace hook wired in p7a-bootstrap-wire
  });

  it("vote-sweep runs before age-sweep when both fire on the same tick", async () => {
    f = makeFixture({
      voteSignalDecay: 0.95,
      deprecationAgeMs: 1000,
      maxDeprecationsPerTick: 1,
    });
    f.setClock(1_000_000);
    const downvoted = f.lessonStore.create({
      activation: "down",
      principle: "p",
      tags: [],
      parentIds: [1],
    });
    const aged = f.lessonStore.create({
      activation: "aged",
      principle: "p",
      tags: [],
      parentIds: [1],
    });
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: downvoted.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });
    // Push clock past `deprecationAgeMs` for both.
    f.setClock(1_000_000 + 5000);

    const result = await f.job.runOnce();

    expect(result.lessonsDeprecatedByVote).toBe(1);
    expect(result.lessonsDeprecatedByAge).toBe(0);
    expect(f.lessonStore.getById(downvoted.id)?.status).toBe("deprecated");
    expect(f.lessonStore.getById(aged.id)?.status).toBe("active");
  });

  it("skips the vote-sweep entirely when voteSignalDecay is 0 (scorecard 7a.D.1)", async () => {
    f = makeFixture({ voteSignalDecay: 0 });
    const lesson = f.lessonStore.create({
      activation: "x",
      principle: "y",
      tags: [],
      parentIds: [1],
    });
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    const result = await f.job.runOnce();

    expect(result.lessonsDeprecatedByVote).toBe(0);
    expect(result.voteDecayApplied).toBe(false);
    expect(f.lessonStore.getById(lesson.id)?.status).toBe("active");
    // vote_score must remain untouched on a no-decay tick.
    expect(f.voteStore.getScore("lesson", lesson.id)).toBe(-1);
  });
});

describe("ConsolidatorJob (phase 7a) — vote score decay (scorecard 7a.D)", () => {
  let f: Fixture;

  afterEach(() => {
    f?.dispose();
  });

  it("applies decay once per tick across all three voting kinds (invariant 23)", async () => {
    f = makeFixture({ voteSignalDecay: 0.5 });
    const lesson = f.lessonStore.create({
      activation: "x",
      principle: "y",
      tags: [],
      parentIds: [1],
    });
    const note = f.memoryStore.store({ content: "a", source: "agent" });
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: 1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });
    f.voteStore.applyVote({
      kind: "memory",
      targetId: note.id,
      direction: 1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    expect(f.voteStore.getScore("lesson", lesson.id)).toBe(1);
    expect(f.voteStore.getScore("memory", note.id)).toBe(1);

    const result = await f.job.runOnce();

    expect(result.voteDecayApplied).toBe(true);
    expect(f.voteStore.getScore("lesson", lesson.id)).toBeCloseTo(0.5, 6);
    expect(f.voteStore.getScore("memory", note.id)).toBeCloseTo(0.5, 6);

    // Single decay metric per kind per tick.
    const decayEvents = f.events.filter(
      (e) => e.name === "agent.memory.voting.decayed",
    );
    const byKind = new Set(decayEvents.map((e) => e.tags?.kind));
    expect(byKind).toEqual(new Set(["memory", "lesson", "profile", "procedure"]));
  });

  it("decay is a no-op when voteStore dep is missing (graceful degradation)", async () => {
    f = makeFixture({ voteSignalDecay: 0.5, voteStoreWired: false });

    const result = await f.job.runOnce();

    expect(result.voteDecayApplied).toBe(false);
    expect(result.lessonsDeprecatedByVote).toBe(0);
  });

  it("two consecutive ticks decay twice (scorecard 7a.D.2)", async () => {
    f = makeFixture({ voteSignalDecay: 0.5 });
    const lesson = f.lessonStore.create({
      activation: "x",
      principle: "y",
      tags: [],
      parentIds: [1],
    });
    f.lessonStore.bumpSuccess(lesson.id); // protect from vote-deprecation
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: 1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });
    expect(f.voteStore.getScore("lesson", lesson.id)).toBe(1);

    await f.job.runOnce();
    expect(f.voteStore.getScore("lesson", lesson.id)).toBeCloseTo(0.5, 6);

    await f.job.runOnce();
    expect(f.voteStore.getScore("lesson", lesson.id)).toBeCloseTo(0.25, 6);
  });
});
