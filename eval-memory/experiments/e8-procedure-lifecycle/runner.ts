/**
 * E8 — deterministic procedure lifecycle bench for Phase 7b.
 *
 * Mirror of E7's lesson lifecycle bench, but adds:
 *  - per-procedure use_count fixture path (mirrors success_count
 *    semantics; either positive value saves an age-eligible row),
 *  - cross-store cascade verification (lesson dies → procedure
 *    that references it as a parent dies with reason `cascade`),
 *  - FIFO eviction by `(vote_score ASC, updated_at ASC)` when
 *    `active_count > maxEntries`.
 *
 * The runner is pure: no LLM, no network. `DistillRunner` is
 * mocked with a no-op completer, and the dataset deliberately
 * avoids seeding episodes that could trigger clustering. The
 * consolidator's distillation loop short-circuits on
 * `clusters.length === 0`; we only exercise the post-distill
 * sweep + decay + cascade path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../../../src/memory/memory-store.js";
import { LinkStore } from "../../../src/memory/links/link-store.js";
import { LessonStore } from "../../../src/memory/lessons/lesson-store.js";
import {
  ProcedureStore,
  type Procedure,
} from "../../../src/memory/procedures/procedure-store.js";
import { ConsolidatorJob } from "../../../src/memory/consolidator/consolidator-job.js";
import { DistillRunner } from "../../../src/memory/consolidator/distill-runner.js";
import { VoteStore } from "../../../src/memory/voting/index.js";

import {
  PROCEDURE_LIFECYCLE_SCENARIOS,
  type ExpectedProcedureStatus,
  type LessonFixtureLite,
  type ProcedureFixture,
  type ProcedureLifecycleScenario,
} from "./dataset.js";

export interface RerankOutcome {
  matched: boolean;
  expected: readonly string[];
  produced: readonly string[];
}

export interface PerHandleOutcome {
  handle: string;
  expected: ExpectedProcedureStatus;
  actual: "active" | "deprecated";
  matched: boolean;
}

export interface TickTally {
  byVote: number;
  byAge: number;
  byOverflow: number;
  byCascade: number;
}

export interface ScenarioResult {
  scenarioId: string;
  label: string;
  finalStatus: Record<string, "active" | "deprecated">;
  tick: TickTally;
  goldTally: TickTally;
  perHandle: readonly PerHandleOutcome[];
  matchedHandles: number;
  mismatchedHandles: number;
  reasonTallyMatched: boolean;
  rerank?: RerankOutcome;
}

export interface E8Aggregate {
  scenarios: number;
  handles: number;
  statusPrecision: number;
  reasonTallyPrecision: number;
  rerankPrecision: number;
}

export interface E8Report {
  scenarios: readonly ScenarioResult[];
  aggregate: E8Aggregate;
}

export async function runE8(): Promise<E8Report> {
  const scenarios: ScenarioResult[] = [];
  for (const s of PROCEDURE_LIFECYCLE_SCENARIOS) {
    scenarios.push(await runOneScenario(s));
  }
  return { scenarios, aggregate: aggregate(scenarios) };
}

async function runOneScenario(
  scenario: ProcedureLifecycleScenario,
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-eval-e8-"));
  const dbFile = join(dir, "memory.sqlite");
  const frozenNow = 1_700_000_000_000;

  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000_000_000 },
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
  const voteStore = new VoteStore({ db });

  const lessonHandleToId = new Map<string, number>();
  const procedureHandleToId = new Map<string, number>();

  try {
    // Seed lessons first so procedures can resolve `parentLessonHandles`.
    for (const fx of scenario.lessons ?? []) {
      seedLesson(fx, dbFile, frozenNow, db, lessonHandleToId);
    }
    // ProcedureStore requires at least one parent lesson id per row. We
    // create an inert placeholder lesson once per scenario so fixtures
    // that do not declare an explicit `parentLessonHandles` still
    // satisfy the contract without polluting the cascade test.
    const placeholderLessonId = seedPlaceholderLesson(
      dbFile,
      frozenNow,
      lessonHandleToId,
    );
    for (const fx of scenario.procedures) {
      seedProcedure(
        fx,
        dbFile,
        frozenNow,
        db,
        lessonHandleToId,
        procedureHandleToId,
        scenario.procedureMaxEntries,
        placeholderLessonId,
      );
    }

    const consolidatorLessonStore = new LessonStore({
      dbFile,
      now: () => frozenNow,
    });
    const consolidatorProcedureStore = new ProcedureStore({
      dbFile,
      now: () => frozenNow,
      ...(scenario.procedureMaxEntries !== undefined
        ? { maxEntries: scenario.procedureMaxEntries }
        : {}),
    });
    let result: ScenarioResult;
    try {
      const distill = new DistillRunner({
        llmComplete: async () =>
          ({
            content: `LESSON activation="x"; principle="y"\n`,
            reasoningContent: null,
            finishReason: "stop",
            usage: null,
          }) as never,
        slotId: -1,
        timeoutMs: 5_000,
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
          deprecationAgeMs:
            (scenario.lessonDeprecationAgeDays ?? 365) * 86_400_000,
          procedureDeprecationAgeMs:
            (scenario.procedureDeprecationAgeDays ?? 0) * 86_400_000,
          maxDeprecationsPerTick: 1000,
          voteSignalDecay: 0.95,
        },
        {
          memoryStore,
          linkStore,
          lessonStore: consolidatorLessonStore,
          procedureStore: consolidatorProcedureStore,
          distillRunner: distill,
          voteStore,
          now: () => frozenNow,
        },
      );
      const tick = await consolidator.runOnce();
      consolidator.stop();

      let rerank: RerankOutcome | undefined;
      if (scenario.rerank) {
        const rows: Procedure[] = consolidatorProcedureStore.recall({
          query: scenario.rerank.query,
          k: scenario.rerank.k,
          scoreBlend: scenario.rerank.scoreBlend,
        });
        const idToHandle = new Map<number, string>();
        for (const [handle, id] of procedureHandleToId) idToHandle.set(id, handle);
        const produced = rows.map((r) => idToHandle.get(r.id) ?? `<unknown:${r.id}>`);
        rerank = {
          expected: scenario.rerank.expectedTopOrder,
          produced,
          matched:
            produced.length === scenario.rerank.expectedTopOrder.length &&
            produced.every((h, i) => h === scenario.rerank!.expectedTopOrder[i]),
        };
      }

      result = synthesiseResult(
        scenario,
        procedureHandleToId,
        consolidatorProcedureStore,
        {
          byVote: tick.proceduresDeprecatedByVote,
          byAge: tick.proceduresDeprecatedByAge,
          byOverflow: tick.proceduresDeprecatedByOverflow,
          byCascade: tick.proceduresDeprecatedByCascade,
        },
        rerank ?? null,
      );
    } finally {
      consolidatorLessonStore.close();
      consolidatorProcedureStore.close();
    }
    return result;
  } finally {
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedLesson(
  fx: LessonFixtureLite,
  dbFile: string,
  frozenNow: number,
  db: ReturnType<MemoryStore["getDatabaseHandleForEmbeddings"]>,
  out: Map<string, number>,
): void {
  const store = new LessonStore({ dbFile, now: () => frozenNow });
  try {
    const lesson = store.create({
      activation: fx.activation,
      principle: fx.principle,
      parentIds: [1],
    });
    if (typeof fx.voteScore === "number" && fx.voteScore !== 0) {
      db.prepare("UPDATE lessons SET vote_score = ? WHERE id = ?")
        .run(fx.voteScore, lesson.id);
    }
    out.set(fx.handle, lesson.id);
  } finally {
    store.close();
  }
}

function seedPlaceholderLesson(
  dbFile: string,
  frozenNow: number,
  lessonHandleToId: Map<string, number>,
): number {
  const store = new LessonStore({ dbFile, now: () => frozenNow });
  try {
    const placeholder = store.create({
      activation: "(e8 placeholder — never deprecates)",
      principle: "Inert lesson so non-cascade procedures can satisfy parent_lesson_ids.",
      parentIds: [1],
    });
    lessonHandleToId.set("__e8_placeholder__", placeholder.id);
    return placeholder.id;
  } finally {
    store.close();
  }
}

function seedProcedure(
  fx: ProcedureFixture,
  dbFile: string,
  frozenNow: number,
  db: ReturnType<MemoryStore["getDatabaseHandleForEmbeddings"]>,
  lessonHandleToId: Map<string, number>,
  out: Map<string, number>,
  maxEntries: number | undefined,
  placeholderLessonId: number,
): void {
  const createdAt = frozenNow + (fx.createdAtOffsetMs ?? 0);
  const explicitParents = (fx.parentLessonHandles ?? []).map((h) => {
    const id = lessonHandleToId.get(h);
    if (id === undefined) {
      throw new Error(
        `seedProcedure: unknown parent lesson handle '${h}' for procedure '${fx.handle}'`,
      );
    }
    return id;
  });
  const parentLessonIds =
    explicitParents.length > 0 ? explicitParents : [placeholderLessonId];
  const store = new ProcedureStore({
    dbFile,
    now: () => createdAt,
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  });
  try {
    const procedure = store.create({
      activation: fx.activation,
      steps: fx.steps.map((s) => ({
        description: s.description,
        toolHint: s.toolHint ?? null,
      })),
      parentLessonIds,
      parentMemoryIds: [1],
      ...(fx.tags ? { tags: [...fx.tags] } : {}),
      source: "consolidator",
    });
    // success_count / use_count are mutable via the public API. We
    // run the bumps with the procedure's own clock so the
    // `updated_at` it stamps is consistent with the fixture's
    // createdAtOffsetMs.
    for (let i = 0; i < (fx.successCount ?? 0); i += 1) {
      store.bumpSuccess(procedure.id);
    }
    for (let i = 0; i < (fx.useCount ?? 0); i += 1) {
      store.bumpUse(procedure.id);
    }
    if (typeof fx.voteScore === "number" && fx.voteScore !== 0) {
      db.prepare("UPDATE procedures SET vote_score = ? WHERE id = ?")
        .run(fx.voteScore, procedure.id);
    }
    out.set(fx.handle, procedure.id);
  } finally {
    store.close();
  }
}

function synthesiseResult(
  scenario: ProcedureLifecycleScenario,
  handleToId: Map<string, number>,
  store: ProcedureStore,
  tick: TickTally,
  rerank: RerankOutcome | null,
): ScenarioResult {
  const finalStatus: Record<string, "active" | "deprecated"> = {};
  const perHandle: PerHandleOutcome[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const [handle, id] of handleToId) {
    const proc = store.getById(id);
    const actual: "active" | "deprecated" =
      proc?.status === "deprecated" ? "deprecated" : "active";
    finalStatus[handle] = actual;
    const expected = scenario.expected[handle];
    if (expected === undefined) {
      perHandle.push({ handle, expected: "active", actual, matched: false });
      continue;
    }
    const ok =
      (expected === "active" && actual === "active") ||
      (expected !== "active" && actual === "deprecated");
    if (ok) matched += 1;
    else mismatched += 1;
    perHandle.push({ handle, expected, actual, matched: ok });
  }
  const goldTally = computeGoldTally(scenario);
  const reasonTallyMatched =
    tick.byVote === goldTally.byVote &&
    tick.byAge === goldTally.byAge &&
    tick.byOverflow === goldTally.byOverflow &&
    tick.byCascade === goldTally.byCascade;
  return {
    scenarioId: scenario.id,
    label: scenario.label,
    finalStatus,
    tick,
    goldTally,
    perHandle,
    matchedHandles: matched,
    mismatchedHandles: mismatched,
    reasonTallyMatched,
    ...(rerank ? { rerank } : {}),
  };
}

function computeGoldTally(scenario: ProcedureLifecycleScenario): TickTally {
  let byVote = 0;
  let byAge = 0;
  let byOverflow = 0;
  let byCascade = 0;
  for (const status of Object.values(scenario.expected)) {
    if (status === "deprecated_by_vote") byVote += 1;
    else if (status === "deprecated_by_age") byAge += 1;
    else if (status === "deprecated_by_overflow") byOverflow += 1;
    else if (status === "deprecated_by_cascade") byCascade += 1;
  }
  return { byVote, byAge, byOverflow, byCascade };
}

function aggregate(scenarios: readonly ScenarioResult[]): E8Aggregate {
  const handles = scenarios.reduce(
    (s, sc) => s + sc.matchedHandles + sc.mismatchedHandles,
    0,
  );
  const matched = scenarios.reduce((s, sc) => s + sc.matchedHandles, 0);
  const reasonOk = scenarios.filter((sc) => sc.reasonTallyMatched).length;
  const rerankScenarios = scenarios.filter((sc) => sc.rerank);
  const rerankOk = rerankScenarios.filter((sc) => sc.rerank?.matched).length;
  return {
    scenarios: scenarios.length,
    handles,
    statusPrecision: handles === 0 ? 0 : matched / handles,
    reasonTallyPrecision: scenarios.length === 0 ? 0 : reasonOk / scenarios.length,
    rerankPrecision: rerankScenarios.length === 0 ? 1 : rerankOk / rerankScenarios.length,
  };
}
