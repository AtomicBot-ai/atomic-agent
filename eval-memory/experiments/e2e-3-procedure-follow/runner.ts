/**
 * E2E-3 runner. Four sessions + one consolidator-tick with
 * `withProcedure=true`.
 *
 * Asserts:
 *   - procedures table count >= 1 after the tick,
 *   - at least one stored procedure has a step whose toolHint matches
 *     any of `expectedToolHints`,
 *   - S4 final reply mentions at least one of `s4ReplyKeywords` (a
 *     loose "procedure influenced the answer" signal).
 */

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { driveMultiSession, type MultiSessionStepResult } from "../../harness/multi-session-driver.js";

import { E2E_3_SCENARIO } from "./dataset.js";

export interface E2E3SessionMetrics {
  label: string;
  sessionId: string | null;
  turnCount: number;
  totalSteps: number;
  totalDurationMs: number;
  lastReply: string;
  toolCallNames: readonly string[];
}

export interface E2E3ConsolidatorMetrics {
  label: string;
  kind: "ok" | "no_clusters" | "failed";
  clustersConsidered: number;
  lessonsCreated: number;
  proceduresCreated: number;
  reason?: string;
}

export interface ProcedureSnapshot {
  activation: string;
  steps: ReadonlyArray<{ description: string; toolHint: string | null }>;
  tags: readonly string[];
}

export interface E2E3Report {
  scenarioId: "e2e-3-procedure-follow";
  label: string;
  sessions: readonly E2E3SessionMetrics[];
  consolidator: E2E3ConsolidatorMetrics;
  proceduresAfterConsolidate: number;
  storedProcedures: readonly ProcedureSnapshot[];
  procedureMatchesToolHints: boolean;
  s4MentionsKeywords: boolean;
  /**
   * True iff S4 called `memory.procedures.recall` — a hard signal
   * that the persisted Procedure round-tripped into the prompt and
   * the agent actively pulled it. This is more deterministic than
   * `s4MentionsKeywords`, which depends on free-form reply phrasing
   * and is mildly stochastic under Gemma-4 sampling.
   */
  s4CalledProcedureRecall: boolean;
  expectedToolHints: readonly string[];
  s4ReplyKeywords: readonly string[];
  passed: boolean;
}

export interface E2E3Options {
  llamaUrl: string;
  maxSteps?: number;
  perSessionTimeoutMs?: number;
  stateDir?: string;
}

export async function runE2E3(opts: E2E3Options): Promise<E2E3Report> {
  const ownedDir = opts.stateDir
    ? null
    : mkdtempSync(join(tmpdir(), "atomic-eval-e2e3-"));
  const stateDir = opts.stateDir ?? join(ownedDir!, "state");
  // BUG-FIX: a previous iteration accidentally aliased `workingDir`
  // to `opts.stateDir` when an external state dir was supplied. That
  // dumped the CSV fixtures inside `<stateDir>/exports/` while the
  // agent's cwd-relative glob (`./exports/**/*.csv`) walked the same
  // path — by luck it would have matched, except `<stateDir>` also
  // holds `memory.sqlite`, `traces/`, `tasks.sqlite`, and the
  // session DB grew with our CSV bytes next to it. Keep cwd
  // separate from stateDir; when a caller supplies an external
  // stateDir we plant the cwd as a sibling so the layout stays
  // predictable on debug runs.
  const workingDir = opts.stateDir
    ? join(opts.stateDir, "..", "cwd")
    : join(ownedDir!, "cwd");
  const scenario = E2E_3_SCENARIO;

  seedFixtures(workingDir, scenario.csvFixtures);

  try {
    const report = await driveMultiSession({
      stateDir,
      workingDir,
      llamaUrl: opts.llamaUrl,
      // E2E-3 specifically tests Phase 7b procedure capture +
      // surfacing. Flip the gate on so `memory.procedures.recall`
      // stays in the descriptor catalog and the consolidator persists
      // procedures (the `withProcedure: true` step below alone would
      // produce a procedure row, but it would never round-trip into a
      // later session because the tool is filtered out by default).
      proceduresEnabled: true,
      steps: [
        // S1..S3 are "log the recipe" sessions; they should land at
        // step count = 2 (memory.notes.store + reply). The tight
        // maxSteps + timeout below catch run-away tool exploration
        // early — Gemma-4 occasionally gets distracted by os.fs.list
        // or os.git.status and we'd rather fail fast than burn five
        // minutes per session.
        {
          kind: "session",
          label: "S1",
          prompts: scenario.sessions.s1Prompts,
          maxSteps: opts.maxSteps ?? 4,
          timeoutMs: opts.perSessionTimeoutMs ?? 60_000,
        },
        {
          kind: "session",
          label: "S2",
          prompts: scenario.sessions.s2Prompts,
          maxSteps: opts.maxSteps ?? 4,
          timeoutMs: opts.perSessionTimeoutMs ?? 60_000,
        },
        {
          kind: "session",
          label: "S3",
          prompts: scenario.sessions.s3Prompts,
          maxSteps: opts.maxSteps ?? 4,
          timeoutMs: opts.perSessionTimeoutMs ?? 60_000,
        },
        {
          kind: "consolidate",
          label: "between S3 and S4 (withProcedure)",
          withProcedure: true,
          minClusterSize: 3,
          // Steer the link-sweep imperative away from the default
          // vendor/eslint example — for CSV-scan notes the model
          // disconnects when the recipe in the example feels
          // unrelated to the candidate bodies.
          linkSweepExample:
            "e.g. both describe an os.fs.glob → os.fs.grep CSV scan recipe",
        },
        // S4 actually executes the recipe and has the freshly-
        // distilled Lesson + Procedure to lean on. Wider step budget
        // and a longer timeout — this is the only session that does
        // real fs work.
        {
          kind: "session",
          label: "S4",
          prompts: scenario.sessions.s4Prompts,
          maxSteps: opts.maxSteps ?? 12,
          timeoutMs: opts.perSessionTimeoutMs ?? 180_000,
        },
      ],
    });

    const sessions = report.steps
      .filter((s) => s.kind === "session")
      .map(toSessionMetrics);
    const consMetrics = toConsolidatorMetrics(
      report.steps.find((s) => s.kind === "consolidate"),
    );

    const { count: procsAfter, hits } = inspectProcedures(stateDir);
    const procedureMatchesToolHints = hits.some((p) =>
      p.steps.some(
        (s) =>
          s.toolHint != null &&
          scenario.expectedToolHints.some((t) => s.toolHint!.includes(t)),
      ),
    );
    const s4 = sessions.find((s) => s.label === "S4");
    const s4Reply = (s4?.lastReply ?? "").toLowerCase();
    const s4MentionsKeywords = scenario.s4ReplyKeywords.some((kw) =>
      s4Reply.includes(kw.toLowerCase()),
    );
    const s4CalledProcedureRecall =
      s4?.toolCallNames.includes("memory.procedures.recall") ?? false;

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      sessions,
      consolidator: consMetrics,
      proceduresAfterConsolidate: procsAfter,
      storedProcedures: hits,
      procedureMatchesToolHints,
      s4MentionsKeywords,
      s4CalledProcedureRecall,
      expectedToolHints: scenario.expectedToolHints,
      s4ReplyKeywords: scenario.s4ReplyKeywords,
      // Phase 7b success criterion: the procedure was distilled AND
      // referenced expected tools AND S4 either explicitly recalled
      // the procedure (hard signal) or mentioned the recipe tools
      // in its reply (loose proxy). The OR keeps the test robust
      // against Gemma-4 phrasing drift while still requiring the
      // procedure-recall surface to be observably exercised.
      passed:
        procsAfter > 0 &&
        procedureMatchesToolHints &&
        (s4MentionsKeywords || s4CalledProcedureRecall),
    };
  } finally {
    if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
  }
}

function seedFixtures(
  workingDir: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): void {
  for (const f of files) {
    const full = resolve(workingDir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content, "utf8");
  }
}

function toSessionMetrics(s: MultiSessionStepResult): E2E3SessionMetrics {
  if (s.kind !== "session") {
    return {
      label: s.label,
      sessionId: null,
      turnCount: 0,
      totalSteps: 0,
      totalDurationMs: 0,
      lastReply: "",
      toolCallNames: [],
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
  const toolCalls = turns.flatMap((t) => t.toolCalls.map((c) => c.tool));
  return {
    label: s.label,
    sessionId: s.result.sessionId,
    turnCount: turns.length,
    totalSteps: turns.reduce((sum, t) => sum + t.stepCount, 0),
    totalDurationMs: s.result.durationMs,
    lastReply,
    toolCallNames: toolCalls,
  };
}

function toConsolidatorMetrics(s: MultiSessionStepResult | undefined): E2E3ConsolidatorMetrics {
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

function inspectProcedures(stateDir: string): {
  count: number;
  hits: ReadonlyArray<ProcedureSnapshot>;
} {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT activation, steps, tags FROM procedures WHERE status = 'active'",
        )
        .all() as Array<{ activation: string; steps: string; tags: string | null }>;
      const hits = rows.map((r) => ({
        activation: r.activation,
        steps: parseStepsJson(r.steps),
        tags: parseTagsJson(r.tags),
      }));
      return { count: hits.length, hits };
    } finally {
      db.close();
    }
  } catch {
    return { count: 0, hits: [] };
  }
}

function parseStepsJson(
  raw: string,
): ReadonlyArray<{ description: string; toolHint: string | null }> {
  try {
    const parsed = JSON.parse(raw) as Array<{ description?: unknown; toolHint?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => ({
      description: typeof p.description === "string" ? p.description : "",
      toolHint: typeof p.toolHint === "string" ? p.toolHint : null,
    }));
  } catch {
    return [];
  }
}

function parseTagsJson(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}
