/**
 * E2E-5 runner. One session with six alternating prompts +
 * one explicit consolidator tick (so reports include the vote-sweep
 * outcome). The assertions read `memories.vote_score` directly.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { driveMultiSession, type MultiSessionStepResult } from "../../harness/multi-session-driver.js";

import { E2E_5_SCENARIO } from "./dataset.js";

export interface E2E5SessionMetrics {
  label: string;
  sessionId: string | null;
  turnCount: number;
  totalSteps: number;
  totalDurationMs: number;
}

export interface E2E5ConsolidatorMetrics {
  label: string;
  kind: "ok" | "no_clusters" | "failed";
  clustersConsidered: number;
  lessonsCreated: number;
  proceduresCreated: number;
  memoriesDeprecatedByVote: number;
  reason?: string;
}

export interface VoteHistogram {
  total: number;
  positive: number;
  negative: number;
  zero: number;
  maxPositive: number;
  minNegative: number;
}

export interface E2E5Report {
  scenarioId: "e2e-5-vote-cleansing";
  label: string;
  session: E2E5SessionMetrics;
  consolidator: E2E5ConsolidatorMetrics;
  histogram: VoteHistogram;
  /** Top-3 memories by vote_score, with content previews. */
  topUpvoted: ReadonlyArray<{ id: number; voteScore: number; preview: string }>;
  /** Bottom-3 memories by vote_score. */
  topDownvoted: ReadonlyArray<{ id: number; voteScore: number; preview: string }>;
  hasPositiveVote: boolean;
  hasNegativeVote: boolean;
  passed: boolean;
}

export interface E2E5Options {
  llamaUrl: string;
  maxSteps?: number;
  perSessionTimeoutMs?: number;
  stateDir?: string;
}

export async function runE2E5(opts: E2E5Options): Promise<E2E5Report> {
  const ownedDir = opts.stateDir
    ? null
    : mkdtempSync(join(tmpdir(), "atomic-eval-e2e5-"));
  const stateDir = opts.stateDir ?? join(ownedDir!, "state");
  // Same workingDir/stateDir aliasing bug as E2E-3/E2E-4/E2E-1 v1 —
  // when an external `stateDir` is supplied, keep cwd as a sibling.
  const workingDir = opts.stateDir
    ? join(opts.stateDir, "..", "cwd")
    : join(ownedDir!, "cwd");
  const scenario = E2E_5_SCENARIO;

  try {
    const report = await driveMultiSession({
      stateDir,
      workingDir,
      llamaUrl: opts.llamaUrl,
      // Phase 7a vote pipeline is ship-dark in production
      // (`memory.voting.enabled=false` default). E2E-5 is the
      // sole scenario that exercises it end-to-end.
      votingEnabled: true,
      steps: [
        // Phase 1 — deterministic fixture for the vote pipeline.
        // The subject of E2E-5 is "user signal → vote_score moves",
        // not "reflection extracts a noise note". Without seeding
        // the noise row often went missing and gated the assertion
        // on memory-creation variance unrelated to the test goal.
        {
          kind: "seed_memories",
          label: "fixture: useful + noise memories",
          entries: scenario.seedMemories.map((m) => ({
            content: m.content,
            ...(m.tags !== undefined ? { tags: m.tags } : {}),
            source: "agent" as const,
            sessionId: "e2e5-fixture",
          })),
        },
        {
          kind: "session",
          label: "S1 (4 turns)",
          prompts: scenario.prompts,
          maxSteps: opts.maxSteps ?? 6,
          timeoutMs: opts.perSessionTimeoutMs ?? 600_000,
        },
        {
          kind: "consolidate",
          label: "after S1 (vote sweep)",
          withProcedure: false,
        },
      ],
    });

    const sessionStep = report.steps.find((s) => s.kind === "session");
    const session = toSessionMetrics(sessionStep);
    const cons = toConsolidatorMetrics(report.steps.find((s) => s.kind === "consolidate"));

    const memoryRows = readMemoriesWithVotes(stateDir);
    const histogram = histogramFromRows(memoryRows);
    const sortedDesc = [...memoryRows].sort((a, b) => b.voteScore - a.voteScore);
    const topUpvoted = sortedDesc.slice(0, 3);
    const topDownvoted = sortedDesc.slice(-3).reverse();

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      session,
      consolidator: cons,
      histogram,
      topUpvoted,
      topDownvoted,
      hasPositiveVote: scenario.expectPositiveVotes ? histogram.positive > 0 : true,
      hasNegativeVote: scenario.expectNegativeVotes ? histogram.negative > 0 : true,
      passed:
        (scenario.expectPositiveVotes ? histogram.positive > 0 : true) &&
        (scenario.expectNegativeVotes ? histogram.negative > 0 : true),
    };
  } finally {
    if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
  }
}

function toSessionMetrics(s: MultiSessionStepResult | undefined): E2E5SessionMetrics {
  if (!s || s.kind !== "session") {
    return {
      label: "(missing)",
      sessionId: null,
      turnCount: 0,
      totalSteps: 0,
      totalDurationMs: 0,
    };
  }
  const turns = s.result.turns;
  return {
    label: s.label,
    sessionId: s.result.sessionId,
    turnCount: turns.length,
    totalSteps: turns.reduce((sum, t) => sum + t.stepCount, 0),
    totalDurationMs: s.result.durationMs,
  };
}

function toConsolidatorMetrics(
  s: MultiSessionStepResult | undefined,
): E2E5ConsolidatorMetrics {
  if (!s || s.kind !== "consolidate") {
    return {
      label: "(missing)",
      kind: "failed",
      clustersConsidered: 0,
      lessonsCreated: 0,
      proceduresCreated: 0,
      memoriesDeprecatedByVote: 0,
      reason: "consolidator step missing",
    };
  }
  if (s.outcome.kind === "ok") {
    const r = s.outcome.result;
    return {
      label: s.label,
      kind: "ok",
      clustersConsidered: r.clustersConsidered,
      lessonsCreated: r.lessonsCreated,
      proceduresCreated: r.proceduresCreated,
      // The lesson-level vote sweep already moves a `lessonsDeprecatedByVote`
      // counter. There is no parallel counter for raw memories in the
      // ConsolidatorTickResult shape; we capture lesson-vote deprecations
      // here as a proxy for "vote sweep was alive".
      memoriesDeprecatedByVote: r.lessonsDeprecatedByVote,
    };
  }
  if (s.outcome.kind === "no_clusters") {
    return {
      label: s.label,
      kind: "no_clusters",
      clustersConsidered: 0,
      lessonsCreated: 0,
      proceduresCreated: 0,
      memoriesDeprecatedByVote: 0,
    };
  }
  return {
    label: s.label,
    kind: "failed",
    clustersConsidered: 0,
    lessonsCreated: 0,
    proceduresCreated: 0,
    memoriesDeprecatedByVote: 0,
    reason: s.outcome.reason,
  };
}

function readMemoriesWithVotes(
  stateDir: string,
): ReadonlyArray<{ id: number; voteScore: number; preview: string }> {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT id, content, vote_score FROM memories")
        .all() as Array<{ id: number; content: string; vote_score: number }>;
      return rows.map((r) => ({
        id: r.id,
        voteScore: r.vote_score ?? 0,
        preview: (r.content ?? "").replace(/\s+/g, " ").slice(0, 100),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function histogramFromRows(
  rows: ReadonlyArray<{ voteScore: number }>,
): VoteHistogram {
  let pos = 0;
  let neg = 0;
  let zero = 0;
  let maxPos = 0;
  let minNeg = 0;
  for (const r of rows) {
    if (r.voteScore > 0) {
      pos += 1;
      if (r.voteScore > maxPos) maxPos = r.voteScore;
    } else if (r.voteScore < 0) {
      neg += 1;
      if (r.voteScore < minNeg) minNeg = r.voteScore;
    } else {
      zero += 1;
    }
  }
  return {
    total: rows.length,
    positive: pos,
    negative: neg,
    zero,
    maxPositive: maxPos,
    minNegative: minNeg,
  };
}
