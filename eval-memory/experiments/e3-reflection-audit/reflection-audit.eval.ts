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

import { runE3, type E3Report } from "./runner.js";

/**
 * E3 vitest entry. Requires:
 *
 *  - `ATOMIC_AGENT_EVAL_LLAMA_URL` (chat llama, for the reflection
 *    call). When missing, the script wrapper `scripts/run-e3.mjs`
 *    brings up the managed daemon and sets this var.
 *  - OPENROUTER_API_KEY (judge). The whole spec is skipped when the
 *    judge is unavailable — E3 is judge-bound, there is no useful
 *    fallback.
 *
 * Decision-boundary asserts:
 *  - usefulnessRate >= ATOMIC_AGENT_E3_MIN_USEFULNESS (default 0.60)
 *  - wrongnessRate  <= ATOMIC_AGENT_E3_MAX_WRONGNESS  (default 0.10)
 *  - noneCorrectness >= 0.5 (at least half of "expects_none" cases
 *    correctly produced NONE)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_USEFULNESS = envNumber("ATOMIC_AGENT_E3_MIN_USEFULNESS", 0.6);
const MAX_WRONGNESS = envNumber("ATOMIC_AGENT_E3_MAX_WRONGNESS", 0.1);
const MIN_NONE_CORRECTNESS = envNumber("ATOMIC_AGENT_E3_MIN_NONE_CORRECTNESS", 0.5);

describe.sequential("E3 — reflection signal-to-noise audit", () => {
  let report: E3Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason = "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e3.mjs";
      return;
    }
    const judge = resolveJudge();
    if (!judge) {
      skipReason = "judge unavailable (missing OPENROUTER_API_KEY); cannot grade reflection entries";
      return;
    }
    const llmComplete = createLlmComplete({ baseUrl: llamaUrl, timeoutMs: 60_000 });
    run = startReportRun({ label: "e3" });
    report = await runE3({ llmComplete, judge: judge.client });
    writeE3Reports(run, report);
  });

  afterAll(() => undefined);

  it("usefulness rate clears the floor", () => {
    if (skipReason) {
      console.warn(`[E3] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.usefulnessRate,
      `usefulnessRate=${report!.aggregate.usefulnessRate.toFixed(3)} below ${MIN_USEFULNESS}`,
    ).toBeGreaterThanOrEqual(MIN_USEFULNESS);
  });

  it("wrongness rate stays under the ceiling", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.wrongnessRate,
      `wrongnessRate=${report!.aggregate.wrongnessRate.toFixed(3)} above ${MAX_WRONGNESS}`,
    ).toBeLessThanOrEqual(MAX_WRONGNESS);
  });

  it("NONE handling on chit-chat / trivia cases is acceptable", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.noneCorrectness,
      `noneCorrectness=${report!.aggregate.noneCorrectness.toFixed(3)} below ${MIN_NONE_CORRECTNESS}`,
    ).toBeGreaterThanOrEqual(MIN_NONE_CORRECTNESS);
  });
});

function writeE3Reports(run: ReportRun, report: E3Report): void {
  const jsonlPath = reportPath(run, "e3", "e3-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const c of report.cases) {
    appendJsonl(jsonlPath, {
      type: "case",
      caseId: c.caseId,
      label: c.label,
      expectation: c.expectation,
      expectationMet: c.expectationMet,
      parsedKind: c.parsed.kind,
      raw: c.raw,
      durationMs: c.durationMs,
    });
    for (const g of c.graded) appendJsonl(jsonlPath, { type: "entry", ...g });
  }

  writeCsv(
    reportPath(run, "e3", "e3-entries.csv"),
    ["caseId", "kind", "rendered", "score", "reason", "judgeMs"] as const,
    report.cases.flatMap((c) => c.graded.map((g) => ({ ...g, rendered: g.rendered.replace(/\n/g, " ") }))),
  );

  const lines: string[] = [
    "# E3 — reflection signal-to-noise audit",
    "",
    `cases: ${report.aggregate.cases}, entries: ${report.aggregate.entries}`,
    `usefulness P(score≥4): **${report.aggregate.usefulnessRate.toFixed(3)}**`,
    `wrongness P(score≤1): **${report.aggregate.wrongnessRate.toFixed(3)}**`,
    `none-correctness: **${report.aggregate.noneCorrectness.toFixed(3)}**`,
    `mean entry score: ${report.aggregate.meanScore.toFixed(2)} / 5`,
    "",
    "## Per case",
    "",
    "| case | expectation | met? | extracted | mean score |",
    "|---|---|---|---:|---:|",
  ];
  for (const c of report.cases) {
    const mean =
      c.graded.length === 0
        ? "—"
        : (c.graded.reduce((s, g) => s + g.score, 0) / c.graded.length).toFixed(2);
    lines.push(
      `| ${c.caseId} | ${c.expectation} | ${c.expectationMet ? "yes" : "no"} | ${c.graded.length} | ${mean} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e3", "e3-summary.md"), lines);
}
