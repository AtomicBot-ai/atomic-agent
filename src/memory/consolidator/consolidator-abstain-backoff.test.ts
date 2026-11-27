import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LessonStore } from "../lessons/lesson-store.js";
import { LinkStore } from "../links/link-store.js";
import { MemoryStore } from "../memory-store.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { ConsolidationStateStore } from "./consolidation-state-store.js";
import { ConsolidatorJob } from "./consolidator-job.js";
import { DistillRunner } from "./distill-runner.js";

const ABSTAIN = `LESSON activation="(no consensus)"; principle="(no durable advice)"\n`;
const LESSON = `LESSON activation="When working with pnpm"; principle="Use pnpm install."\n`;
const INTERVAL_MS = 60_000;

interface Fixture {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  state: ConsolidationStateStore;
  job: ConsolidatorJob;
  /** Raw output per LLM call; an `Error` makes that call throw. */
  outputs: Array<string | Error>;
  llmCalls: number;
  logLines: Array<{ message: string; context?: Record<string, unknown> }>;
  clock: number;
  dispose(): void;
}

function makeFixture(opts: { maxClustersPerTick?: number; maxEntries?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "atomic-consolidator-backoff-"));
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: opts.maxEntries ?? 100,
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
  const lessonStore = new LessonStore({ dbFile: join(dir, "memory.sqlite") });
  const fixture = {
    outputs: [] as Array<string | Error>,
    llmCalls: 0,
    logLines: [] as Fixture["logLines"],
    clock: 10_000,
  } as Fixture;
  const record = (message: string, context?: Record<string, unknown>) => {
    fixture.logLines.push({ message, ...(context ? { context } : {}) });
  };
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as unknown as StructuredLogger;
  const distillRunner = new DistillRunner({
    llmComplete: async () => {
      const next = fixture.outputs[fixture.llmCalls] ?? LESSON;
      fixture.llmCalls += 1;
      if (next instanceof Error) throw next;
      return {
        content: next,
        reasoningContent: null,
        finishReason: "stop",
        usage: null,
      } as never;
    },
    slotId: -1,
    timeoutMs: 5_000,
  });
  fixture.memoryStore = memoryStore;
  fixture.linkStore = linkStore;
  fixture.lessonStore = lessonStore;
  fixture.state = new ConsolidationStateStore({ db });
  fixture.job = new ConsolidatorJob(
    {
      enabled: true,
      intervalMs: INTERVAL_MS,
      cooldownMs: 0,
      minClusterSize: 3,
      maxClustersPerTick: opts.maxClustersPerTick ?? 5,
      requireSharedTag: false,
      consolidationLeaseMs: 60_000,
    },
    {
      memoryStore,
      linkStore,
      lessonStore,
      distillRunner,
      stateStore: fixture.state,
      logger,
      now: () => fixture.clock,
    },
  );
  fixture.dispose = () => {
    lessonStore.close();
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return fixture;
}

/** Three linked notes; returns their ids ascending. */
function linkedTriple(f: Fixture, label: string, at = 1_000): number[] {
  const notes = ["A", "B", "C"].map((n) =>
    f.memoryStore.store({ content: `${label} note ${n}`, source: "agent" }, at),
  );
  f.linkStore.add({ fromId: notes[0]!.id, toId: notes[1]!.id, kind: "RELATES_TO" });
  f.linkStore.add({ fromId: notes[1]!.id, toId: notes[2]!.id, kind: "RELATES_TO" });
  return notes.map((n) => n.id);
}

const tickLines = (f: Fixture) =>
  f.logLines.filter((l) => l.message === "consolidator.tick");

describe("ConsolidatorJob abstain backoff (ATO-2506)", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture({ maxClustersPerTick: 1 });
  });

  afterEach(() => {
    f.dispose();
  });

  it("puts an abstained cluster off so the next tick distills another one", async () => {
    const stubborn = linkedTriple(f, "stubborn");
    const other = linkedTriple(f, "other");
    f.outputs = [ABSTAIN, LESSON];

    const first = await f.job.runOnce();
    expect(first.lessonsAbstained).toBe(1);
    expect(first.notesDeferred).toBe(3);
    for (const id of stubborn) {
      expect(f.state.getBackoff(id)).toEqual({
        abstains: 1,
        retryAt: f.clock + INTERVAL_MS,
      });
    }

    f.clock += 1_000;
    const second = await f.job.runOnce();
    expect(second.lessonsCreated).toBe(1);
    // Without the backoff the lowest-id cluster is picked again.
    for (const id of other) {
      expect(f.memoryStore.getConsolidatedInto(id)).not.toBeNull();
    }
    for (const id of stubborn) {
      expect(f.memoryStore.getConsolidatedInto(id)).toBeNull();
    }
  });

  it("retries the cluster once the wait is over and doubles it on a repeat abstain", async () => {
    const stubborn = linkedTriple(f, "stubborn");
    f.outputs = [ABSTAIN, ABSTAIN];
    const start = f.clock;

    await f.job.runOnce();
    expect(f.llmCalls).toBe(1);

    f.clock = start + INTERVAL_MS - 1;
    const waiting = await f.job.runOnce();
    expect(waiting.candidates).toBe(0);
    expect(f.llmCalls).toBe(1);

    f.clock = start + INTERVAL_MS;
    const retried = await f.job.runOnce();
    expect(retried.lessonsAbstained).toBe(1);
    expect(f.llmCalls).toBe(2);
    expect(f.state.getBackoff(stubborn[0]!)).toEqual({
      abstains: 2,
      retryAt: f.clock + 2 * INTERVAL_MS,
    });
  });

  it("makes an abstained note due again when its content is edited", async () => {
    const triple = linkedTriple(f, "stubborn");
    f.outputs = [ABSTAIN, LESSON];

    await f.job.runOnce();
    expect(f.state.getBackoff(triple[0]!)).not.toBeNull();

    // Still inside the wait: without the reset the edited note (and so
    // the cluster) stays out of the next tick.
    f.clock += 1_000;
    f.memoryStore.updateContent(triple[0]!, "stubborn note A, rewritten", f.clock - 500);
    expect(f.state.getBackoff(triple[0]!)).toBeNull();
    for (const id of triple.slice(1)) {
      expect(f.state.getBackoff(id)).not.toBeNull();
    }

    const next = await f.job.runOnce();
    expect(next.candidates).toBe(1);
    expect(f.llmCalls).toBe(1);
  });

  it("does not put a cluster off after a model failure", async () => {
    const triple = linkedTriple(f, "flaky");
    f.outputs = [new Error("llama-server went away"), LESSON];

    const failed = await f.job.runOnce();
    expect(failed.failures).toBe(1);
    expect(failed.notesDeferred).toBe(0);
    expect(f.state.getBackoff(triple[0]!)).toBeNull();

    f.clock += 1_000;
    const retried = await f.job.runOnce();
    expect(retried.lessonsCreated).toBe(1);
  });
});

describe("ConsolidatorJob candidate paging (ATO-2506)", () => {
  it("reaches notes older than the newest page on a later tick", async () => {
    const f = makeFixture({ maxEntries: 1_000 });
    try {
      const old = linkedTriple(f, "old", 1_000);
      // A full page of newer notes that never cluster.
      for (let i = 0; i < 200; i += 1) {
        f.memoryStore.store({ content: `lone note ${i}`, source: "agent" }, 5_000);
      }

      const first = await f.job.runOnce();
      expect(first.candidatePage).toBe("first");
      expect(first.candidates).toBe(200);
      expect(first.lessonsCreated).toBe(0);

      const second = await f.job.runOnce();
      expect(second.candidatePage).toBe("next");
      expect(second.lessonsCreated).toBe(1);
      for (const id of old) {
        expect(f.memoryStore.getConsolidatedInto(id)).not.toBeNull();
      }
    } finally {
      f.dispose();
    }
  });
});

describe("ConsolidatorJob tick log line (ATO-2506)", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.dispose();
  });

  it("writes one consolidator.tick line on a tick with nothing to do", async () => {
    await f.job.runOnce();
    const lines = tickLines(f);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.context).toMatchObject({
      outcome: "none",
      candidates: 0,
      clusters: 0,
      lessonsCreated: 0,
    });
  });

  it("writes exactly one consolidator.tick line on a tick that writes a lesson", async () => {
    linkedTriple(f, "pnpm");
    await f.job.runOnce();
    const lines = tickLines(f);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.context).toMatchObject({
      outcome: "ok",
      candidates: 3,
      clusters: 1,
      lessonsCreated: 1,
    });
  });

  it("logs a skipped tick when the previous one is still running", async () => {
    linkedTriple(f, "pnpm");
    await Promise.all([f.job.runOnce(), f.job.runOnce()]);
    const lines = tickLines(f);
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.context?.skipped === "already_running")).toHaveLength(1);
  });
});
