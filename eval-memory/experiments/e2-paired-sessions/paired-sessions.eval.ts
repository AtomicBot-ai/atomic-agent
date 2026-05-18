import { beforeAll, describe, expect, it } from "vitest";

import { resolveJudge } from "../../harness/judge.js";
import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";
import type { PairedRunOptions } from "../../harness/paired-runner.js";

import { runE2, type E2Report } from "./runner.js";

/**
 * E2 — paired multi-turn sessions (ON vs OFF).
 *
 * Requires the chat llama-server (the agent's own LLM, not the
 * judge). Optionally an embedding daemon when the ON profile wants
 * hybrid recall.
 *
 * Decision boundaries (env-tunable):
 *  - ATOMIC_AGENT_E2_MIN_SCORE_DELTA  (default 0.4)
 *  - ATOMIC_AGENT_E2_MIN_WIN_RATE     (default 0.5)
 *  - ATOMIC_AGENT_E2_MAX_REGRESSIONS  (default 1)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_SCORE_DELTA = envNumber("ATOMIC_AGENT_E2_MIN_SCORE_DELTA", 0.4);
const MIN_WIN_RATE = envNumber("ATOMIC_AGENT_E2_MIN_WIN_RATE", 0.5);
const MAX_REGRESSIONS = envNumber("ATOMIC_AGENT_E2_MAX_REGRESSIONS", 1);

const SCENARIO_TIMEOUT_MS = envNumber("ATOMIC_AGENT_E2_SCENARIO_TIMEOUT_MS", 6 * 60_000);
const MAX_STEPS_PER_TURN = envNumber("ATOMIC_AGENT_E2_MAX_STEPS_PER_TURN", 30);

// E2 is the heaviest experiment: 4 scenarios × 2 sides × 3 turns ×
// per-turn LLM latency. The default 120 s beforeAll budget is not
// enough. Lift it via an env override so CI / slow models still have
// a knob; default 30 minutes covers a 9B model on Apple Silicon.
const BEFORE_ALL_TIMEOUT_MS = envNumber("ATOMIC_AGENT_E2_BEFORE_ALL_MS", 30 * 60_000);

describe.sequential("E2 — paired multi-turn sessions", () => {
  let report: E2Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason = "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e2.mjs";
      return;
    }
    const judge = resolveJudge();
    if (!judge) {
      skipReason = "judge unavailable (missing OPENROUTER_API_KEY); cannot grade replies";
      return;
    }
    const embeddings = process.env.ATOMIC_AGENT_EVAL_EMBED_URL
      ? {
          enabled: true,
          ...(process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL
            ? { modelId: process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL }
            : {}),
        }
      : { enabled: false };
    const pairedRunOptions: PairedRunOptions = {
      llamaUrl,
      embeddings,
      preferOnFirst: true,
      cleanupTempDirs: process.env.ATOMIC_AGENT_E2_KEEP_TEMP !== "1",
    };
    run = startReportRun({ label: "e2" });
    report = await runE2(
      { judge: judge.client, pairedRunOptions },
      { timeoutMs: SCENARIO_TIMEOUT_MS, maxStepsPerTurn: MAX_STEPS_PER_TURN },
    );
    writeE2Reports(run, report);
  }, BEFORE_ALL_TIMEOUT_MS);

  it("ON beats OFF on average by the minimum margin", () => {
    if (skipReason) {
      console.warn(`[E2] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.meanScoreDelta,
      `meanScoreDelta=${report!.aggregate.meanScoreDelta.toFixed(2)} below ${MIN_SCORE_DELTA}`,
    ).toBeGreaterThanOrEqual(MIN_SCORE_DELTA);
  });

  it("ON wins at least half the scenarios", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const total = report!.aggregate.scenarios;
    const wins = report!.aggregate.winsOn + report!.aggregate.ties;
    const winRate = total === 0 ? 0 : wins / total;
    expect(
      winRate,
      `winRate(on incl. ties)=${winRate.toFixed(3)} below ${MIN_WIN_RATE}`,
    ).toBeGreaterThanOrEqual(MIN_WIN_RATE);
  });

  it("no excessive regressions where ON lost by ≥1 point", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.regressions,
      `regressions=${report!.aggregate.regressions} exceeds budget ${MAX_REGRESSIONS}`,
    ).toBeLessThanOrEqual(MAX_REGRESSIONS);
  });
});

function writeE2Reports(run: ReportRun, report: E2Report): void {
  const jsonlPath = reportPath(run, "e2", "e2-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const s of report.scenarios) {
    appendJsonl(jsonlPath, {
      type: "scenario",
      scenarioId: s.scenarioId,
      label: s.label,
      scoredTurnIndex: s.scoredTurnIndex,
      onReply: s.onReply,
      offReply: s.offReply,
      onScore: s.onScore,
      offScore: s.offScore,
      onReason: s.onReason,
      offReason: s.offReason,
      delta_score: s.delta_score,
      delta: s.delta,
      onSessionId: s.on.run.sessionId,
      offSessionId: s.off.run.sessionId,
      onTurns: s.on.run.turns.length,
      offTurns: s.off.run.turns.length,
      onMemoryArtifacts: s.delta.onMemoryArtifacts,
    });
  }

  writeCsv(
    reportPath(run, "e2", "e2-scenarios.csv"),
    [
      "scenarioId",
      "label",
      "onScore",
      "offScore",
      "delta_score",
      "toolCallsDelta",
      "promptTokensDelta",
      "onMemoryArtifacts",
    ] as const,
    report.scenarios.map((s) => ({
      scenarioId: s.scenarioId,
      label: s.label,
      onScore: s.onScore,
      offScore: s.offScore,
      delta_score: s.delta_score,
      toolCallsDelta: s.delta.toolCallsDelta,
      promptTokensDelta: s.delta.promptTokensDelta,
      onMemoryArtifacts: s.delta.onMemoryArtifacts,
    })),
  );

  const lines: string[] = [
    "# E2 — paired multi-turn sessions",
    "",
    `scenarios: ${report.aggregate.scenarios}`,
    `mean ON score: **${report.aggregate.meanOnScore.toFixed(2)} / 5**`,
    `mean OFF score: **${report.aggregate.meanOffScore.toFixed(2)} / 5**`,
    `mean score delta: **${report.aggregate.meanScoreDelta.toFixed(2)}**`,
    `wins (on): ${report.aggregate.winsOn}, ties: ${report.aggregate.ties}, wins (off): ${report.aggregate.winsOff}`,
    `regressions (off>=on+1): ${report.aggregate.regressions}`,
    `mean prompt-tokens delta (on − off): ${report.aggregate.meanPromptTokensDelta.toFixed(0)}`,
    `mean tool-calls delta (on − off): ${report.aggregate.meanToolCallsDelta.toFixed(2)}`,
    "",
    "## Per scenario",
    "",
    "| scenario | ON | OFF | Δ | tool Δ | tokens Δ | mem artifacts (on) |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of report.scenarios) {
    lines.push(
      `| ${s.scenarioId} | ${s.onScore} | ${s.offScore} | ${s.delta_score} | ${s.delta.toolCallsDelta} | ${s.delta.promptTokensDelta} | ${s.delta.onMemoryArtifacts} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e2", "e2-summary.md"), lines);
}
