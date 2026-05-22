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

import { runE4, type E4Report } from "./runner.js";

/**
 * E4 — distillation-quality audit. Same env-driven gating as E3.
 *
 *  - ATOMIC_AGENT_E4_MIN_USEFUL_RATE (default 0.6)
 *  - ATOMIC_AGENT_E4_MAX_WRONG_RATE  (default 0.15)
 *  - ATOMIC_AGENT_E4_MIN_MEAN_SCORE  (default 3.0)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_USEFUL = envNumber("ATOMIC_AGENT_E4_MIN_USEFUL_RATE", 0.6);
const MAX_WRONG = envNumber("ATOMIC_AGENT_E4_MAX_WRONG_RATE", 0.15);
const MIN_MEAN = envNumber("ATOMIC_AGENT_E4_MIN_MEAN_SCORE", 3.0);

describe.sequential("E4 — distillation quality audit", () => {
  let report: E4Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason = "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e4.mjs";
      return;
    }
    const judge = resolveJudge();
    if (!judge) {
      skipReason = "judge unavailable (missing OPENROUTER_API_KEY); cannot grade lessons";
      return;
    }
    const llmComplete = createLlmComplete({ baseUrl: llamaUrl, timeoutMs: 90_000 });
    run = startReportRun({ label: "e4" });
    report = await runE4({ llmComplete, judge: judge.client });
    writeE4Reports(run, report);
  });

  afterAll(() => undefined);

  it("useful lessons rate clears the floor", () => {
    if (skipReason) {
      console.warn(`[E4] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.usefulLessonsRate,
      `usefulLessonsRate=${report!.aggregate.usefulLessonsRate.toFixed(3)} below ${MIN_USEFUL}`,
    ).toBeGreaterThanOrEqual(MIN_USEFUL);
  });

  it("wrong lessons rate stays under the ceiling", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.wrongLessonsRate,
      `wrongLessonsRate=${report!.aggregate.wrongLessonsRate.toFixed(3)} above ${MAX_WRONG}`,
    ).toBeLessThanOrEqual(MAX_WRONG);
  });

  it("mean lesson score is at least 3 / 5", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    if (report!.aggregate.lessons === 0) {
      throw new Error("no lessons produced; consolidator abstained on every cluster");
    }
    expect(
      report!.aggregate.meanLessonScore,
      `meanLessonScore=${report!.aggregate.meanLessonScore.toFixed(2)} below ${MIN_MEAN}`,
    ).toBeGreaterThanOrEqual(MIN_MEAN);
  });
});

function writeE4Reports(run: ReportRun, report: E4Report): void {
  const jsonlPath = reportPath(run, "e4", "e4-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const c of report.clusters) {
    appendJsonl(jsonlPath, {
      type: "cluster",
      clusterId: c.clusterId,
      label: c.label,
      status: c.status,
      gold: c.gold,
      produced: c.produced,
      raw: c.raw,
      meanScore: c.meanScore,
      durationMs: c.durationMs,
    });
    for (const a of c.axisScores) {
      appendJsonl(jsonlPath, {
        type: "axis",
        clusterId: c.clusterId,
        axis: a.axis,
        score: a.score,
        reason: a.reason,
      });
    }
  }

  writeCsv(
    reportPath(run, "e4", "e4-clusters.csv"),
    ["clusterId", "label", "status", "meanScore", "activationScore", "principleScore", "coverageScore"] as const,
    report.clusters.map((c) => ({
      clusterId: c.clusterId,
      label: c.label,
      status: c.status,
      meanScore: c.meanScore,
      activationScore: c.axisScores.find((a) => a.axis === "activation")?.score ?? "",
      principleScore: c.axisScores.find((a) => a.axis === "principle")?.score ?? "",
      coverageScore: c.axisScores.find((a) => a.axis === "coverage")?.score ?? "",
    })),
  );

  const lines: string[] = [
    "# E4 — distillation quality audit",
    "",
    `clusters: ${report.aggregate.clusters}, lessons produced: ${report.aggregate.lessons}, abstentions: ${report.aggregate.abstentions}, parse failures: ${report.aggregate.parseFailures}, http failures: ${report.aggregate.httpFailures}`,
    `mean lesson score: **${report.aggregate.meanLessonScore.toFixed(2)} / 5**`,
    `useful lessons rate: **${report.aggregate.usefulLessonsRate.toFixed(3)}**`,
    `wrong lessons rate: **${report.aggregate.wrongLessonsRate.toFixed(3)}**`,
    "",
    "## Per cluster",
    "",
    "| cluster | status | mean | activation | principle | coverage |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const c of report.clusters) {
    const a = c.axisScores.find((x) => x.axis === "activation")?.score;
    const p = c.axisScores.find((x) => x.axis === "principle")?.score;
    const cov = c.axisScores.find((x) => x.axis === "coverage")?.score;
    lines.push(
      `| ${c.clusterId} | ${c.status} | ${c.status === "lesson" ? c.meanScore.toFixed(2) : "—"} | ${a ?? "—"} | ${p ?? "—"} | ${cov ?? "—"} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e4", "e4-summary.md"), lines);
}
