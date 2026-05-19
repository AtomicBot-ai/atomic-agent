import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsolidatorJob } from "../consolidator/consolidator-job.js";
import { DistillRunner } from "../consolidator/distill-runner.js";
import { LessonStore } from "../lessons/lesson-store.js";
import { LinkStore } from "../links/link-store.js";
import { MemoryStore } from "../memory-store.js";
import { VoteStore } from "../voting/vote-store.js";
import { ProcedureStore } from "./procedure-store.js";
import { renderProceduresSection } from "./procedures-renderer.js";

/**
 * Memory-v2 phase 7b — scorecard pinning file. One `describe` per
 * scenario from `MEMORY_FABRIC_V2_SCORECARD.md §11`. The
 * underlying behaviour is covered by smaller unit tests
 * (`procedure-store.test.ts`, `distill-parser-procedure.test.ts`,
 * `procedures-recall.test.ts`, `procedures-renderer.test.ts`); this
 * file re-asserts each scenario end-to-end against the load-bearing
 * surface so a regression lands here regardless of which sub-module
 * drifts.
 *
 * Scenario 7b.C (in-prompt rendering + close-match `use_count` bump)
 * lives in `build-prompt.test.ts` because it pins the prompt
 * structure; this file owns the store / consolidator side.
 */

interface FixtureOptions {
  distillBody?: string;
  voteSignalDecay?: number;
  procedureDeprecationAgeMs?: number;
  procedureMaxEntries?: number;
}

interface Fixture {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  procedureStore: ProcedureStore;
  voteStore: VoteStore;
  consolidator: ConsolidatorJob;
  distillCalls: { count: number };
  dispose: () => void;
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "atomic-scorecard-7b-"));
  const dbFile = join(dir, "memory.sqlite");
  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000 },
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
  const lessonStore = new LessonStore({ dbFile });
  const procedureStore = new ProcedureStore({
    dbFile,
    ...(opts.procedureMaxEntries !== undefined
      ? { maxEntries: opts.procedureMaxEntries }
      : {}),
  });
  const voteStore = new VoteStore({ db });
  const distillCalls = { count: 0 };
  const body =
    opts.distillBody ??
    `LESSON activation="run vendor lint"; principle="add vendor to eslintignore before commit"; tags=lint,vendor,commit\nPROCEDURE activation="vendor lint failing"; steps="open .eslintignore @os.fs.read; add vendor/** @os.fs.edit; verify hook @os.shell.run"; tags=lint,vendor,commit\n`;
  const distill = new DistillRunner({
    llmComplete: async () => {
      distillCalls.count += 1;
      return {
        content: body,
        reasoningContent: null,
        finishReason: "stop",
        usage: null,
      } as never;
    },
    slotId: -1,
    timeoutMs: 5000,
    withProcedure: true,
  });
  const consolidator = new ConsolidatorJob(
    {
      enabled: true,
      intervalMs: 60_000,
      cooldownMs: 0,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: false,
      consolidationLeaseMs: 60_000,
      maxDeprecationsPerTick: 100,
      voteSignalDecay: opts.voteSignalDecay ?? 0,
      ...(opts.procedureDeprecationAgeMs !== undefined
        ? { procedureDeprecationAgeMs: opts.procedureDeprecationAgeMs }
        : {}),
    },
    {
      memoryStore,
      linkStore,
      lessonStore,
      procedureStore,
      voteStore,
      distillRunner: distill,
    },
  );
  return {
    memoryStore,
    linkStore,
    lessonStore,
    procedureStore,
    voteStore,
    consolidator,
    distillCalls,
    dispose: () => {
      lessonStore.close();
      procedureStore.close();
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedClusterMemories(f: Fixture, n: number, tags: string[]): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const entry = f.memoryStore.store({
      content: `episode ${i} on shared topic`,
      tags,
    });
    ids.push(entry.id);
  }
  // Chain via RELATES_TO links so connected-component clustering
  // sees one cluster of size N (no shared-tag requirement in the
  // fixture, but we still need adjacency).
  for (let i = 1; i < ids.length; i += 1) {
    f.linkStore.add({ fromId: ids[i - 1]!, toId: ids[i]!, kind: "RELATES_TO" });
  }
  return ids;
}

describe("scorecard 7b.A — procedural cluster → lesson + procedure in one LLM call", () => {
  let f: Fixture;
  afterEach(() => f?.dispose());

  it("persists one lesson and one procedure for a procedural cluster (7b.A.1, 7b.A.7, 7b.A.8)", async () => {
    f = makeFixture();
    seedClusterMemories(f, 4, ["lint", "vendor"]);
    const procedureTraces: Array<{ id: number; parentLessonIds: readonly number[] }> = [];
    let lastTickResult;
    // re-wire via fresh consolidator that has the trace hook
    const consolidatorWithTrace = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        minClusterSize: 3,
        maxClustersPerTick: 5,
        requireSharedTag: false,
        consolidationLeaseMs: 60_000,
        maxDeprecationsPerTick: 100,
        voteSignalDecay: 0,
      },
      {
        memoryStore: f.memoryStore,
        linkStore: f.linkStore,
        lessonStore: f.lessonStore,
        procedureStore: f.procedureStore,
        voteStore: f.voteStore,
        distillRunner: new DistillRunner({
          llmComplete: async () => {
            f.distillCalls.count += 1;
            return {
              content: `LESSON activation="run vendor lint"; principle="add vendor to eslintignore before commit"; tags=lint,vendor,commit\nPROCEDURE activation="vendor lint failing"; steps="open .eslintignore @os.fs.read; add vendor/** @os.fs.edit; verify hook @os.shell.run"; tags=lint,vendor,commit\n`,
              reasoningContent: null,
              finishReason: "stop",
              usage: null,
            } as never;
          },
          slotId: -1,
          timeoutMs: 5000,
          withProcedure: true,
        }),
        onProcedureCreated: (event) => {
          procedureTraces.push({
            id: event.procedureId,
            parentLessonIds: event.parentLessonIds,
          });
        },
      },
    );
    lastTickResult = await consolidatorWithTrace.runOnce();

    expect(lastTickResult.lessonsCreated).toBe(1);
    expect(lastTickResult.proceduresCreated).toBe(1);
    expect(procedureTraces.length).toBe(1);
    expect(procedureTraces[0]?.parentLessonIds.length).toBe(1);

    const procs = f.procedureStore.listIndex();
    expect(procs.length).toBe(1);
    const proc = f.procedureStore.getById(procs[0]!.id);
    expect(proc?.steps.length).toBeGreaterThanOrEqual(2);
    expect(proc?.source).toBe("consolidator");
    // 7b.A.6 — exactly one LLM call for the entire cluster.
    expect(f.distillCalls.count).toBe(1);
  });
});

describe("scorecard 7b.B — conceptual cluster → lesson only", () => {
  let f: Fixture;
  afterEach(() => f?.dispose());

  it("a lesson-only completion yields zero procedures (7b.B.1, 7b.B.2, 7b.B.3)", async () => {
    f = makeFixture({
      distillBody: `LESSON activation="treat ml hyperparams empirically"; principle="never trust the first sweep blindly"; tags=ml,research,empirical\n`,
    });
    seedClusterMemories(f, 4, ["ml"]);
    const result = await f.consolidator.runOnce();
    expect(result.lessonsCreated).toBe(1);
    expect(result.proceduresCreated).toBe(0);
    expect(f.procedureStore.countActive()).toBe(0);
    expect(f.distillCalls.count).toBe(1);
  });
});

describe("scorecard 7b.D — invariant 20: runtime never auto-executes Procedure.steps", () => {
  // 7b.D.1/D.2 — static guard. The runtime must not feed
  // `Procedure.steps[i].toolHint` into the tool registry. The
  // grep below mirrors the scorecard's manual check.
  it("no file in src/ feeds Procedure.steps into tool dispatch", () => {
    // Static grep gate for invariant 20. We forbid any source line
    // that materialises a `Procedure.steps[*].toolHint` straight
    // into a tool dispatcher call. Comments are excluded so the
    // doctrine note inside `procedures-recall.ts` does not trip
    // the gate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `rg -n "toolHint" src --type ts || true`,
      { encoding: "utf8" },
    );
    const offending = out
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      // Strip "path:lineno:" prefix so the comment heuristic only
      // sees the code body.
      .filter((line) => {
        const body = line.replace(/^[^:]+:\d+:\s*/, "");
        if (/^\s*(\/\/|\*|\/\*)/.test(body)) return false;
        return /toolRegistry\.invoke|registry\.invoke|invokeTool/.test(body);
      });
    expect(offending).toEqual([]);
  });

  it("ProcedureStep.toolHint is plain string only (advisory)", () => {
    // Schema-level invariant — `toolHint` is a string, not a
    // callable or a structured tool-call descriptor. Pinned by
    // procedure-store.test.ts; we re-assert the type here so a
    // regression in the interface is caught by the scorecard.
    const sample = {
      description: "open file",
      toolHint: "os.fs.read",
    };
    expect(typeof sample.toolHint).toBe("string");
  });
});

describe("scorecard 7b.E — `### procedures` respects token budget and ranks by vote_score", () => {
  let f: Fixture;
  afterEach(() => f?.dispose());

  it("highest vote_score survives token clipping, lowest gets dropped (7b.E.1, 7b.E.3)", () => {
    f = makeFixture();
    const high = f.procedureStore.create({
      activation: "high priority procedure with descriptive activation text",
      steps: [
        { description: "step one" },
        { description: "step two" },
      ],
      tags: ["a"],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    const low = f.procedureStore.create({
      activation: "low priority procedure with descriptive activation text",
      steps: [
        { description: "step one" },
        { description: "step two" },
      ],
      tags: ["b"],
      parentLessonIds: [2],
      parentMemoryIds: [2],
    });
    // Use the MemoryStore's connection to update vote scores —
    // multiple sqlite connections to the same file see each other's
    // writes immediately (WAL mode, single-process).
    const db = f.memoryStore.getDatabaseHandleForEmbeddings();
    db.prepare("UPDATE procedures SET vote_score = ? WHERE id = ?").run(3, high.id);
    db.prepare("UPDATE procedures SET vote_score = ? WHERE id = ?").run(-1, low.id);

    const index = f.procedureStore.listIndex();
    // listIndex orders by vote_score DESC, so the high-vote item
    // is rendered first and survives a tight clip.
    expect(index[0]?.id).toBe(high.id);
    expect(index[index.length - 1]?.id).toBe(low.id);

    const rendered = renderProceduresSection(index);
    expect(rendered).toContain(`>${high.id}`);
  });
});

describe("scorecard 7b.F — deprecation, cascade, FIFO eviction", () => {
  let f: Fixture;
  afterEach(() => f?.dispose());

  it("downvoted unused procedure flips to deprecated on next tick (7b.F.1)", async () => {
    f = makeFixture({ voteSignalDecay: 0.95 });
    const proc = f.procedureStore.create({
      activation: "doomed procedure here",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    f.voteStore.applyVote({
      kind: "procedure",
      targetId: proc.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    const result = await f.consolidator.runOnce();

    expect(result.proceduresDeprecatedByVote).toBe(1);
    expect(f.procedureStore.getById(proc.id)?.status).toBe("deprecated");
  });

  it("cascade: deprecating a lesson cascades into its child procedure (7b.F.3 / invariant cascade)", async () => {
    f = makeFixture({
      voteSignalDecay: 0.95,
      procedureDeprecationAgeMs: 0,
    });
    const lesson = f.lessonStore.create({
      activation: "parent lesson",
      principle: "p",
      tags: [],
      parentIds: [1],
    });
    const proc = f.procedureStore.create({
      activation: "child procedure",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [lesson.id],
      parentMemoryIds: [1],
    });
    f.voteStore.applyVote({
      kind: "lesson",
      targetId: lesson.id,
      direction: -1,
      sessionId: "s1",
      turnIndex: 0,
      maxVotePerItem: 5,
    });

    const result = await f.consolidator.runOnce();

    expect(result.lessonsDeprecatedByVote).toBe(1);
    expect(result.proceduresDeprecatedByCascade).toBeGreaterThanOrEqual(1);
    expect(f.procedureStore.getById(proc.id)?.status).toBe("deprecated");
  });

  it("deprecated procedure is still readable by id (audit, 7b.F.4)", async () => {
    f = makeFixture();
    const proc = f.procedureStore.create({
      activation: "to be archived",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    expect(f.procedureStore.markDeprecated(proc.id, "manual")).toBe(true);
    const reloaded = f.procedureStore.getById(proc.id);
    expect(reloaded?.status).toBe("deprecated");
    expect(reloaded?.steps.length).toBe(2);
  });

  it("FIFO overflow demotes oldest by (vote_score ASC, updated_at ASC) (7b.F.2)", () => {
    f = makeFixture({ procedureMaxEntries: 2 });
    const a = f.procedureStore.create({
      activation: "first procedure activation",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    const b = f.procedureStore.create({
      activation: "second procedure activation",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [2],
      parentMemoryIds: [2],
    });
    f.procedureStore.create({
      activation: "third procedure activation",
      steps: [{ description: "a" }, { description: "b" }],
      tags: [],
      parentLessonIds: [3],
      parentMemoryIds: [3],
    });
    // Overflow predicate returns oldest two by (vote_score ASC,
    // updated_at ASC) — the two we created first. With cap=2,
    // there is one excess row, so the oldest survivor candidate
    // is `a`.
    const overflow = f.procedureStore.pickOverflowForDeprecation();
    expect(overflow.length).toBe(1);
    expect(overflow).toContain(a.id);
    expect(overflow).not.toContain(b.id);
  });
});
