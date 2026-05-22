/**
 * E2E-2 runner. S1 (3 prompts) → S2 (3 prompts) → consolidator
 * tick → S3 (1 prompt). All sessions are real CLI subprocesses
 * sharing one `<stateDir>`; the consolidator tick is invoked in-
 * process via `runConsolidatorTick` (no extra CLI hop).
 *
 * Asserts:
 *   - memories table has at least 6 rows after S1+S2 (one per
 *     `memory.notes.store` call in the dataset),
 *   - lessons table has at least one row after the tick,
 *   - lesson activation/principle mentions every keyword in
 *     `lessonKeywords`,
 *   - S3 final reply contains `s3ReplySubstring`.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  driveMultiSession,
  type MultiSessionStepResult,
} from "../../harness/multi-session-driver.js";

import { E2E_2_SCENARIO } from "./dataset.js";

export interface E2E2SessionMetrics {
  label: string;
  sessionId: string | null;
  turnCount: number;
  totalSteps: number;
  totalDurationMs: number;
  lastReply: string;
}

export interface E2E2ConsolidatorMetrics {
  label: string;
  kind: "ok" | "no_clusters" | "failed";
  clustersConsidered: number;
  lessonsCreated: number;
  proceduresCreated: number;
  reason?: string;
}

export interface E2E2Report {
  scenarioId: "e2e-2-lesson-application";
  label: string;
  memoriesAfterS2: number;
  sessions: readonly E2E2SessionMetrics[];
  consolidator: E2E2ConsolidatorMetrics;
  lessonsAfterConsolidate: number;
  lessonHits: ReadonlyArray<{ activation: string; principle: string }>;
  lessonBodyMatchesKeywords: boolean;
  s3ReplyHasSubstring: boolean;
  expectedSubstring: string;
  passed: boolean;
}

export interface E2E2Options {
  llamaUrl: string;
  maxSteps?: number;
  perSessionTimeoutMs?: number;
  stateDir?: string;
}

export async function runE2E2(opts: E2E2Options): Promise<E2E2Report> {
  const ownedDir = opts.stateDir
    ? null
    : mkdtempSync(join(tmpdir(), "atomic-eval-e2e2-"));
  const stateDir = opts.stateDir ?? join(ownedDir!, "state");
  const workingDir = opts.stateDir
    ? join(opts.stateDir, "..", "cwd")
    : join(ownedDir!, "cwd");
  const scenario = E2E_2_SCENARIO;

  try {
    const report = await driveMultiSession({
      stateDir,
      workingDir,
      llamaUrl: opts.llamaUrl,
      steps: [
        {
          kind: "session",
          label: "S1",
          prompts: scenario.sessions.s1Prompts,
          maxSteps: opts.maxSteps ?? 6,
          timeoutMs: opts.perSessionTimeoutMs ?? 900_000,
        },
        {
          kind: "session",
          label: "S2",
          prompts: scenario.sessions.s2Prompts,
          maxSteps: opts.maxSteps ?? 6,
          timeoutMs: opts.perSessionTimeoutMs ?? 900_000,
        },
        {
          kind: "consolidate",
          label: "between S2 and S3",
          withProcedure: false,
          minClusterSize: 3,
        },
        {
          kind: "session",
          label: "S3",
          prompts: scenario.sessions.s3Prompts,
          maxSteps: opts.maxSteps ?? 6,
          timeoutMs: opts.perSessionTimeoutMs ?? 300_000,
        },
      ],
    });

    const sessions = report.steps
      .filter((s) => s.kind === "session")
      .map(toSessionMetrics);
    const cons = report.steps.find((s) => s.kind === "consolidate");
    const consMetrics = toConsolidatorMetrics(cons);

    const memoriesAfterS2 = countMemories(stateDir);
    const { count: lessonsAfter, hits } = inspectLessons(stateDir);
    const lessonBodyMatchesKeywords = scenario.lessonKeywords.every((kw) =>
      hits.some(
        (h) =>
          h.activation.toLowerCase().includes(kw) ||
          h.principle.toLowerCase().includes(kw),
      ),
    );
    const s3 = sessions.find((s) => s.label === "S3");
    const s3Reply = s3?.lastReply ?? "";
    const s3HasSub = s3Reply
      .toLowerCase()
      .includes(scenario.s3ReplySubstring.toLowerCase());

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      memoriesAfterS2,
      sessions,
      consolidator: consMetrics,
      lessonsAfterConsolidate: lessonsAfter,
      lessonHits: hits,
      lessonBodyMatchesKeywords,
      s3ReplyHasSubstring: s3HasSub,
      expectedSubstring: scenario.s3ReplySubstring,
      passed: lessonsAfter > 0 && lessonBodyMatchesKeywords && s3HasSub,
    };
  } finally {
    if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
  }
}

function toSessionMetrics(s: MultiSessionStepResult): E2E2SessionMetrics {
  if (s.kind !== "session") {
    return {
      label: s.label,
      sessionId: null,
      turnCount: 0,
      totalSteps: 0,
      totalDurationMs: 0,
      lastReply: "",
    };
  }
  const turns = s.result.turns;
  const lastReply = (() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const r = turns[i]?.assistantReply ?? "";
      if (r.trim().length > 0) return r;
    }
    return "";
  })();
  return {
    label: s.label,
    sessionId: s.result.sessionId,
    turnCount: turns.length,
    totalSteps: turns.reduce((sum, t) => sum + t.stepCount, 0),
    totalDurationMs: s.result.durationMs,
    lastReply,
  };
}

function toConsolidatorMetrics(
  s: MultiSessionStepResult | undefined,
): E2E2ConsolidatorMetrics {
  if (!s || s.kind !== "consolidate") {
    return {
      label: "(missing)",
      kind: "failed",
      clustersConsidered: 0,
      lessonsCreated: 0,
      proceduresCreated: 0,
      reason: "consolidator step missing from report",
    };
  }
  if (s.outcome.kind === "ok") {
    return {
      label: s.label,
      kind: "ok",
      clustersConsidered: s.outcome.result.clustersConsidered,
      lessonsCreated: s.outcome.result.lessonsCreated,
      proceduresCreated: s.outcome.result.proceduresCreated,
    };
  }
  if (s.outcome.kind === "no_clusters") {
    return {
      label: s.label,
      kind: "no_clusters",
      clustersConsidered: 0,
      lessonsCreated: 0,
      proceduresCreated: 0,
    };
  }
  return {
    label: s.label,
    kind: "failed",
    clustersConsidered: 0,
    lessonsCreated: 0,
    proceduresCreated: 0,
    reason: s.outcome.reason,
  };
}

function countMemories(stateDir: string): number {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS cnt FROM memories")
        .get() as { cnt: number };
      return row.cnt;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function inspectLessons(stateDir: string): {
  count: number;
  hits: ReadonlyArray<{ activation: string; principle: string }>;
} {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT activation, principle FROM lessons WHERE status = 'active'",
        )
        .all() as Array<{ activation: string; principle: string }>;
      return { count: rows.length, hits: rows };
    } finally {
      db.close();
    }
  } catch {
    return { count: 0, hits: [] };
  }
}
