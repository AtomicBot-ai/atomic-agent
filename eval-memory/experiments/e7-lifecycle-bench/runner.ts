/**
 * E7 — deterministic lifecycle bench for Phase 6 + 7a.
 *
 * Each scenario seeds a fresh `<tmp>/memory.sqlite` with the
 * dataset's lessons, applies the requested vote / age profile, then
 * runs `consolidator.runOnce()` exactly once. The runner asserts:
 *
 *  - Per-lesson final status matches the `expected` map (active vs
 *    deprecated).
 *  - The `(byVote, byAge)` count tuple matches the gold tally so we
 *    pin not just *what* was deprecated but *why*.
 *  - When the scenario carries a `rerank` block, `lessonStore.recall`
 *    under `scoreBlend` returns the expected `(handle, rank)` order.
 *
 * No LLM is involved — `DistillRunner` is mocked with a no-op
 * completer, and the dataset deliberately avoids seeding episodes
 * that could trigger clustering. The consolidator's distillation
 * loop short-circuits on `clusters.length === 0`; we only exercise
 * the post-distill sweep + decay path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../../../src/memory/memory-store.js";
import { LinkStore } from "../../../src/memory/links/link-store.js";
import { LessonStore, type Lesson } from "../../../src/memory/lessons/lesson-store.js";
import { ConsolidatorJob } from "../../../src/memory/consolidator/consolidator-job.js";
import { DistillRunner } from "../../../src/memory/consolidator/distill-runner.js";
import { VoteStore } from "../../../src/memory/voting/index.js";

import {
  LIFECYCLE_SCENARIOS,
  type ExpectedStatus,
  type LessonFixture,
  type LifecycleScenario,
} from "./dataset.js";

export interface RerankOutcome {
  matched: boolean;
  expected: readonly string[];
  produced: readonly string[];
}

export interface PerHandleOutcome {
  handle: string;
  expected: ExpectedStatus;
  actual: "active" | "deprecated";
  matched: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  label: string;
  /** Final status per fixture handle. */
  finalStatus: Record<string, "active" | "deprecated">;
  /** Aggregate tick counts straight from the consolidator. */
  tick: { byVote: number; byAge: number; byOverflow: number };
  /** Gold tally derived from the scenario's `expected` map. */
  goldTally: { byVote: number; byAge: number; byOverflow: number };
  /** Per-handle status delta for the report. */
  perHandle: readonly PerHandleOutcome[];
  matchedHandles: number;
  mismatchedHandles: number;
  reasonTallyMatched: boolean;
  /** Populated only when the scenario carried a rerank block. */
  rerank?: RerankOutcome;
}

export interface E7Aggregate {
  scenarios: number;
  handles: number;
  /** Fraction of (scenario, handle) pairs that landed in the expected status. */
  statusPrecision: number;
  /** Fraction of scenarios whose per-reason tally matched the gold. */
  reasonTallyPrecision: number;
  /** Fraction of rerank scenarios whose top-K order matched. */
  rerankPrecision: number;
}

export interface E7Report {
  scenarios: readonly ScenarioResult[];
  aggregate: E7Aggregate;
}

export async function runE7(): Promise<E7Report> {
  const scenarios: ScenarioResult[] = [];
  for (const s of LIFECYCLE_SCENARIOS) {
    scenarios.push(await runOneScenario(s));
  }
  return { scenarios, aggregate: aggregate(scenarios) };
}

async function runOneScenario(scenario: LifecycleScenario): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-eval-e7-"));
  const dbFile = join(dir, "memory.sqlite");
  // Fixed wall-clock anchor so each scenario is reproducible.
  const frozenNow = 1_700_000_000_000;

  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000_000_000 },
  });
  const db = memoryStore.getDatabaseHandleForEmbeddings();
  const linkStore = new LinkStore({ db });
  const voteStore = new VoteStore({ db });

  const handleToId = new Map<string, number>();
  try {
    for (const fx of scenario.lessons) {
      seedFixture(fx, dbFile, frozenNow, db, handleToId);
    }

    const consolidatorStore = new LessonStore({ dbFile, now: () => frozenNow });
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
          deprecationAgeMs: scenario.deprecationAgeDays * 86_400_000,
          maxDeprecationsPerTick: 100,
          voteSignalDecay: 0.95,
        },
        {
          memoryStore,
          linkStore,
          lessonStore: consolidatorStore,
          distillRunner: distill,
          voteStore,
          now: () => frozenNow,
        },
      );
      const tick = await consolidator.runOnce();
      consolidator.stop();

      let rerank: RerankOutcome | undefined;
      if (scenario.rerank) {
        const rows: Lesson[] = consolidatorStore.recall({
          query: scenario.rerank.query,
          k: scenario.rerank.k,
          scoreBlend: scenario.rerank.scoreBlend,
        });
        const idToHandle = new Map<number, string>();
        for (const [handle, id] of handleToId) idToHandle.set(id, handle);
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
        handleToId,
        consolidatorStore,
        {
          byVote: tick.lessonsDeprecatedByVote,
          byAge: tick.lessonsDeprecatedByAge,
          byOverflow: tick.lessonsDeprecatedByOverflow,
        },
        rerank ?? null,
      );
    } finally {
      consolidatorStore.close();
    }
    return result;
  } finally {
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedFixture(
  fx: LessonFixture,
  dbFile: string,
  frozenNow: number,
  db: ReturnType<MemoryStore["getDatabaseHandleForEmbeddings"]>,
  handleToId: Map<string, number>,
): void {
  const createdAt = frozenNow + (fx.createdAtOffsetMs ?? 0);
  const store = new LessonStore({ dbFile, now: () => createdAt });
  try {
    const lesson = store.create({
      activation: fx.activation,
      principle: fx.principle,
      parentIds: [1],
      ...(fx.tags ? { tags: [...fx.tags] } : {}),
    });
    for (let i = 0; i < (fx.successCount ?? 0); i += 1) {
      store.bumpSuccess(lesson.id);
    }
    if (typeof fx.voteScore === "number" && fx.voteScore !== 0) {
      db.prepare("UPDATE lessons SET vote_score = ? WHERE id = ?")
        .run(fx.voteScore, lesson.id);
    }
    handleToId.set(fx.handle, lesson.id);
  } finally {
    store.close();
  }
}

function synthesiseResult(
  scenario: LifecycleScenario,
  handleToId: Map<string, number>,
  store: LessonStore,
  tick: { byVote: number; byAge: number; byOverflow: number },
  rerank: RerankOutcome | null,
): ScenarioResult {
  const finalStatus: Record<string, "active" | "deprecated"> = {};
  const perHandle: PerHandleOutcome[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const [handle, id] of handleToId) {
    const lesson = store.getById(id);
    const actual: "active" | "deprecated" = lesson?.status === "deprecated" ? "deprecated" : "active";
    finalStatus[handle] = actual;
    const expected = scenario.expected[handle];
    if (expected === undefined) {
      // No expectation declared — treat as informational and skip
      // the precision contribution.
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
    tick.byOverflow === goldTally.byOverflow;
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

function computeGoldTally(scenario: LifecycleScenario): {
  byVote: number;
  byAge: number;
  byOverflow: number;
} {
  let byVote = 0;
  let byAge = 0;
  let byOverflow = 0;
  for (const status of Object.values(scenario.expected)) {
    if (status === "deprecated_by_vote") byVote += 1;
    else if (status === "deprecated_by_age") byAge += 1;
    else if (status === "deprecated_by_overflow") byOverflow += 1;
  }
  return { byVote, byAge, byOverflow };
}

function aggregate(scenarios: readonly ScenarioResult[]): E7Aggregate {
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
