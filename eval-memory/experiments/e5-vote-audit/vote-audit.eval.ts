import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLlmComplete } from "../../harness/llm-client.js";
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

import { runE5, type E5Report } from "./runner.js";

/**
 * E5 vitest entry. Requires:
 *
 *  - `ATOMIC_AGENT_EVAL_LLAMA_URL` (chat llama, for the isolated
 *    vote sub-call). When missing, `scripts/run-e5.mjs` brings up
 *    the managed daemon and sets this var.
 *  - `OPENROUTER_API_KEY` (judge). The whole spec is skipped when
 *    the judge is unavailable — E5 is judge-bound by design.
 *
 * Decision-boundary asserts:
 *  - correctness     >= ATOMIC_AGENT_E5_MIN_CORRECTNESS (default 0.60)
 *  - falseVoteRate   <= ATOMIC_AGENT_E5_MAX_FALSE_VOTE (default 0.20)
 *  - missedSignalRate<= ATOMIC_AGENT_E5_MAX_MISSED     (default 0.50)
 *
 * The thresholds intentionally start permissive: voting is a brand-
 * new sub-call on a 9B model, and Phase 7a's design contract is
 * "drag noise down over many turns", not "be right on the first
 * shot". We tighten the floors as the prompt + decay tuning matures.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_CORRECTNESS = envNumber("ATOMIC_AGENT_E5_MIN_CORRECTNESS", 0.6);
const MAX_FALSE_VOTE = envNumber("ATOMIC_AGENT_E5_MAX_FALSE_VOTE", 0.2);
const MAX_MISSED = envNumber("ATOMIC_AGENT_E5_MAX_MISSED", 0.5);

describe.sequential("E5 — vote decision audit", () => {
  let report: E5Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason = "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e5.mjs";
      return;
    }
    const judge = resolveJudge();
    if (!judge) {
      skipReason = "judge unavailable (missing OPENROUTER_API_KEY); cannot grade vote decisions";
      return;
    }
    const llmComplete = createLlmComplete({ baseUrl: llamaUrl, timeoutMs: 60_000 });
    run = startReportRun({ label: "e5" });
    report = await runE5({ llmComplete, judge: judge.client });
    writeE5Reports(run, report);
  });

  afterAll(() => undefined);

  it("correctness rate clears the floor", () => {
    if (skipReason) {
      console.warn(`[E5] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.correctness,
      `correctness=${report!.aggregate.correctness.toFixed(3)} below ${MIN_CORRECTNESS}`,
    ).toBeGreaterThanOrEqual(MIN_CORRECTNESS);
  });

  it("false-vote rate stays under the ceiling", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.falseVoteRate,
      `falseVoteRate=${report!.aggregate.falseVoteRate.toFixed(3)} above ${MAX_FALSE_VOTE}`,
    ).toBeLessThanOrEqual(MAX_FALSE_VOTE);
  });

  it("missed-signal rate stays under the ceiling", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.missedSignalRate,
      `missedSignalRate=${report!.aggregate.missedSignalRate.toFixed(3)} above ${MAX_MISSED}`,
    ).toBeLessThanOrEqual(MAX_MISSED);
  });

  it("parser never reports allowlist breaches on synthetic data", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.notSurfacedRejections,
      `notSurfacedRejections=${report!.aggregate.notSurfacedRejections} — vote-parser leaked an allowlist breach into the campaign`,
    ).toBe(0);
  });
});

function writeE5Reports(run: ReportRun, report: E5Report): void {
  const jsonlPath = reportPath(run, "e5", "e5-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const c of report.cases) {
    appendJsonl(jsonlPath, {
      type: "case",
      caseId: c.caseId,
      label: c.label,
      parseKind: c.parseKind,
      meanScore: c.meanScore,
      voteCount: c.votes.length,
      rejectedCount: c.rejected.length,
      raw: c.raw,
      durationMs: c.durationMs,
    });
    for (const d of c.decisions) appendJsonl(jsonlPath, { type: "decision", ...d });
  }

  writeCsv(
    reportPath(run, "e5", "e5-decisions.csv"),
    ["caseId", "candidateKey", "gold", "produced", "decision", "score"] as const,
    report.cases.flatMap((c) =>
      c.decisions.map((d) => ({
        caseId: d.caseId,
        candidateKey: d.candidateKey,
        gold: d.gold,
        produced: d.produced,
        decision: d.decision,
        score: d.score,
      })),
    ),
  );

  const lines: string[] = [
    "# E5 — vote decision audit",
    "",
    `cases: ${report.aggregate.cases}, decisions: ${report.aggregate.decisions}, http failures: ${report.aggregate.httpFailures}`,
    `correctness         : **${report.aggregate.correctness.toFixed(3)}**`,
    `false-vote rate     : **${report.aggregate.falseVoteRate.toFixed(3)}**`,
    `missed-signal rate  : **${report.aggregate.missedSignalRate.toFixed(3)}**`,
    `mean decision score : ${report.aggregate.meanScore.toFixed(2)} / 5`,
    `allowlist breaches  : ${report.aggregate.notSurfacedRejections}`,
    "",
    "## Per case",
    "",
    "| case | parse | decisions | mean | sample (gold → produced) |",
    "|---|---|---:|---:|---|",
  ];
  for (const c of report.cases) {
    const sample = c.decisions.slice(0, 3).map((d) => `${d.gold}→${d.produced}`).join(", ") || "—";
    lines.push(
      `| ${c.caseId} | ${c.parseKind} | ${c.decisions.length} | ${c.meanScore.toFixed(2)} | ${sample} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e5", "e5-summary.md"), lines);
}
