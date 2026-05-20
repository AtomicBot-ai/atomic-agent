/**
 * E12 — combined "all three on" smoke runner.
 *
 * One session, three v2.5 flags on, three orthogonal signals
 * harvested:
 *
 *  - reflection.fired count (stderr debug) — cadence gate works.
 *  - rewriter.ok count (stderr debug) — referential follow-ups
 *    fired the rewriter at least once.
 *  - memories.tags inspection — at least one row carries a
 *    `type:*` tag.
 *
 * The runner is a "did the integration not explode" check, not a
 * quality bar. Decision-boundary asserts are intentionally loose;
 * the scorecard §6's precision claims belong on the operator's
 * subjective audit, not on automated CI.
 */

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  driveMultiSession,
  type MultiSessionReport,
} from "../../harness/multi-session-driver.js";
import { countReflectionFires } from "../e10-reflection-segmentation/runner.js";

import { E12_SCENARIO, type E12Scenario } from "./dataset.js";

const ALLOWED_TYPE_TAGS = new Set([
  "type:event",
  "type:behavior",
  "type:knowledge",
  "type:skill",
]);

export interface E12Result {
  scenarioId: string;
  promptsExecuted: number;
  exitCode: number | null;
  durationMs: number;
  reflectionFires: number;
  rewriterFires: number;
  rewriterAttempts: number;
  rowsAfter: number;
  typeTagsObserved: readonly string[];
  ok: boolean;
  failReasons: readonly string[];
  stderrTail: string;
}

export interface E12Report {
  result: E12Result;
}

export interface E12RunnerDeps {
  llamaUrl: string;
}

export async function runE12(deps: E12RunnerDeps): Promise<E12Report> {
  return { result: await runScenario(E12_SCENARIO, deps) };
}

async function runScenario(
  scenario: E12Scenario,
  deps: E12RunnerDeps,
): Promise<E12Result> {
  const startedAt = Date.now();
  const workspace = mkdtempSync(join(tmpdir(), `e12-${scenario.id}-`));
  const stateDir = join(workspace, "state");
  const workingDir = join(workspace, "work");

  let multi: MultiSessionReport;
  try {
    multi = await driveMultiSession({
      workingDir,
      stateDir,
      llamaUrl: deps.llamaUrl,
      rewriterEnabled: true,
      segmentationEnabled: true,
      typedNotesEnabled: true,
      logLevel: "debug",
      steps: [
        {
          kind: "session",
          label: `S1 (${scenario.prompts.length} turns)`,
          prompts: scenario.prompts,
          maxSteps: scenario.maxSteps,
          timeoutMs: scenario.timeoutMs,
          // Drain so reflection-written type:* tags land before
          // `runtime.shutdown()` aborts the fire-and-forget runner.
          postLastReplyDrainMs: 20_000,
          interPromptDrainMs: 12_000,
        },
      ],
    });
  } catch (err) {
    return {
      scenarioId: scenario.id,
      promptsExecuted: 0,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      reflectionFires: 0,
      rewriterFires: 0,
      rewriterAttempts: 0,
      rowsAfter: 0,
      typeTagsObserved: [],
      ok: false,
      failReasons: [
        `driveMultiSession threw: ${err instanceof Error ? err.message : String(err)}`,
      ],
      stderrTail: "",
    };
  }

  const sessionStep = multi.steps.find((s) => s.kind === "session");
  if (!sessionStep || sessionStep.kind !== "session") {
    return {
      scenarioId: scenario.id,
      promptsExecuted: 0,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      reflectionFires: 0,
      rewriterFires: 0,
      rewriterAttempts: 0,
      rowsAfter: 0,
      typeTagsObserved: [],
      ok: false,
      failReasons: ["session step missing from multi-session report"],
      stderrTail: "",
    };
  }

  const stderr = sessionStep.result.stderrAll;
  const reflectionFires = countReflectionFires(stderr);
  const rewriterFires = countRewriterFires(stderr);
  const rewriterAttempts = countRewriterAttempts(stderr);
  const promptsExecuted = sessionStep.result.turns.length;

  const rows = readMemoryRows(stateDir);
  const typeTagsObserved = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags) {
      if (ALLOWED_TYPE_TAGS.has(tag)) typeTagsObserved.add(tag);
    }
  }

  const failReasons: string[] = [];
  if (sessionStep.result.exitCode !== 0) {
    failReasons.push(
      `subprocess exit code = ${sessionStep.result.exitCode} (expected 0)`,
    );
  }
  if (sessionStep.result.timedOut) {
    failReasons.push("subprocess hit the wall-clock timeout");
  }
  if (promptsExecuted < scenario.prompts.length) {
    failReasons.push(
      `only ${promptsExecuted}/${scenario.prompts.length} turns executed`,
    );
  }
  if (reflectionFires === 0) {
    failReasons.push("zero reflection.fired events — segmentation gate may be broken");
  }
  if (rewriterAttempts === 0) {
    failReasons.push(
      "rewriter never reached the LLM; the referential follow-ups did not exercise Phase A",
    );
  }
  if (typeTagsObserved.size === 0) {
    failReasons.push(
      "no type:* tag found in memories.tags — typed-notes prompt may not have engaged",
    );
  }

  return {
    scenarioId: scenario.id,
    promptsExecuted,
    exitCode: sessionStep.result.exitCode,
    durationMs: Date.now() - startedAt,
    reflectionFires,
    rewriterFires,
    rewriterAttempts,
    rowsAfter: rows.length,
    typeTagsObserved: Array.from(typeTagsObserved).sort(),
    ok: failReasons.length === 0,
    failReasons,
    stderrTail: sessionStep.result.stderrTail,
  };
}

/**
 * Count the rewriter's successful debug log lines:
 *   `[<iso>] DEBUG rewriter.ok {...}`
 */
function countRewriterFires(stderr: string): number {
  const re = /\bDEBUG rewriter\.ok\b/g;
  let count = 0;
  for (const _ of stderr.matchAll(re)) count += 1;
  return count;
}

/**
 * Count rewriter attempts that reached the LLM:
 *   `rewriter.ok` (debug) OR `rewriter.failed` (warn).
 * Skipped-by-gate cases (skipped_not_referential / no_history)
 * do not emit a log line and therefore do not contribute.
 */
function countRewriterAttempts(stderr: string): number {
  let count = 0;
  for (const _ of stderr.matchAll(/\bDEBUG rewriter\.ok\b/g)) count += 1;
  for (const _ of stderr.matchAll(/\bWARN rewriter\.failed\b/g)) count += 1;
  return count;
}

function readMemoryRows(stateDir: string): Array<{
  id: number;
  content: string;
  tags: string[];
}> {
  const dbFile = resolve(stateDir, "memory.sqlite");
  const db = new Database(dbFile, { readonly: true, fileMustExist: false });
  try {
    const rows = db
      .prepare(`SELECT id, content, tags FROM memories ORDER BY id ASC`)
      .all() as Array<{ id: number; content: string; tags: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: parseTags(r.tags),
    }));
  } finally {
    db.close();
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
