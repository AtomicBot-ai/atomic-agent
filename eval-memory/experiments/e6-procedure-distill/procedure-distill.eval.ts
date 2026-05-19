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

import { runE6, type E6Report } from "./runner.js";
import { DEFAULT_E6_BOUNDS } from "./dataset.js";

/**
 * E6 — combined lesson+procedure distill audit (phase 7b).
 *
 * Env-overridable boundaries:
 *   - ATOMIC_AGENT_E6_MIN_EXTRACTION_RATE   (default 0.66)
 *   - ATOMIC_AGENT_E6_MAX_FALSE_PROCEDURE   (default 0.34)
 *   - ATOMIC_AGENT_E6_MIN_STEP_COHERENCE    (default 0.6  -> ≥3/5 mean)
 *   - ATOMIC_AGENT_E6_MIN_LESSON_PRODUCED   (default 0.85)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_EXTRACTION = envNumber(
  "ATOMIC_AGENT_E6_MIN_EXTRACTION_RATE",
  DEFAULT_E6_BOUNDS.minExtractionRate,
);
const MAX_FALSE = envNumber(
  "ATOMIC_AGENT_E6_MAX_FALSE_PROCEDURE",
  DEFAULT_E6_BOUNDS.maxFalseProcedureRate,
);
const MIN_COHERENCE = envNumber(
  "ATOMIC_AGENT_E6_MIN_STEP_COHERENCE",
  DEFAULT_E6_BOUNDS.minStepCoherence,
);
const MIN_LESSON = envNumber(
  "ATOMIC_AGENT_E6_MIN_LESSON_PRODUCED",
  DEFAULT_E6_BOUNDS.minLessonStillProduced,
);

describe.sequential("E6 — procedure distill audit", () => {
  let report: E6Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason =
        "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e6.mjs";
      return;
    }
    const judge = resolveJudge();
    if (!judge) {
      skipReason =
        "judge unavailable (missing OPENROUTER_API_KEY); cannot grade procedure steps";
      return;
    }
    const llmComplete = createLlmComplete({ baseUrl: llamaUrl, timeoutMs: 120_000 });
    run = startReportRun({ label: "e6" });
    report = await runE6({ llmComplete, judge: judge.client });
    writeE6Reports(run, report);
  });

  afterAll(() => undefined);

  it("procedure extraction rate clears the floor (procedural clusters)", () => {
    if (skipReason) {
      console.warn(`[E6] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.procedureExtractionRate,
      `extractionRate=${report!.aggregate.procedureExtractionRate.toFixed(3)} below ${MIN_EXTRACTION}`,
    ).toBeGreaterThanOrEqual(MIN_EXTRACTION);
  });

  it("false-procedure rate stays under the ceiling (conceptual clusters)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.falseProcedureRate,
      `falseProcedureRate=${report!.aggregate.falseProcedureRate.toFixed(3)} above ${MAX_FALSE}`,
    ).toBeLessThanOrEqual(MAX_FALSE);
  });

  it("mean step coherence is at least the floor", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    if (report!.aggregate.extractionsCorrect === 0) {
      throw new Error(
        "no procedures emitted on procedural clusters — see extractionRate test",
      );
    }
    // Judge scores are 1..5; the floor is normalised to that scale.
    expect(
      report!.aggregate.meanStepCoherence,
      `meanStepCoherence=${report!.aggregate.meanStepCoherence.toFixed(2)} below ${MIN_COHERENCE * 5}`,
    ).toBeGreaterThanOrEqual(MIN_COHERENCE * 5);
  });

  it("lesson half is preserved (invariant 21: procedure failure must not drop lesson)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.lessonStillProducedRate,
      `lessonStillProducedRate=${report!.aggregate.lessonStillProducedRate.toFixed(3)} below ${MIN_LESSON}`,
    ).toBeGreaterThanOrEqual(MIN_LESSON);
  });
});

function writeE6Reports(run: ReportRun, report: E6Report): void {
  const jsonlPath = reportPath(run, "e6", "e6-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const c of report.clusters) {
    appendJsonl(jsonlPath, {
      type: "cluster",
      clusterId: c.clusterId,
      label: c.label,
      kind: c.kind,
      status: c.status,
      decision: c.decision,
      meanStepScore: c.meanStepScore,
      lessonPresent: c.lessonPresent,
      produced: c.produced,
      raw: c.raw,
      durationMs: c.durationMs,
    });
    for (const s of c.stepScores) {
      appendJsonl(jsonlPath, {
        type: "step",
        clusterId: c.clusterId,
        index: s.index,
        description: s.description,
        toolHint: s.toolHint,
        score: s.score,
        reason: s.reason,
      });
    }
  }

  writeCsv(
    reportPath(run, "e6", "e6-clusters.csv"),
    [
      "clusterId",
      "kind",
      "status",
      "decision",
      "lessonPresent",
      "stepCount",
      "meanStepScore",
    ] as const,
    report.clusters.map((c) => ({
      clusterId: c.clusterId,
      kind: c.kind,
      status: c.status,
      decision: c.decision,
      lessonPresent: c.lessonPresent ? "yes" : "no",
      stepCount: c.stepScores.length,
      meanStepScore: c.meanStepScore.toFixed(2),
    })),
  );

  const lines: string[] = [
    "# E6 — procedure distill audit (phase 7b)",
    "",
    `clusters: ${report.aggregate.clusters} (procedural=${report.aggregate.procedural}, conceptual=${report.aggregate.conceptual})`,
    `extraction rate (procedural)  : **${report.aggregate.procedureExtractionRate.toFixed(3)}**`,
    `false-procedure rate (concept): **${report.aggregate.falseProcedureRate.toFixed(3)}**`,
    `mean step coherence            : **${report.aggregate.meanStepCoherence.toFixed(2)} / 5**`,
    `lesson-still-produced rate     : **${report.aggregate.lessonStillProducedRate.toFixed(3)}**`,
    `http failures: ${report.aggregate.httpFailures}, parse failures: ${report.aggregate.parseFailures}`,
    "",
    "## Per cluster",
    "",
    "| cluster | kind | decision | lesson | step mean |",
    "|---|---|---|:---:|---:|",
  ];
  for (const c of report.clusters) {
    const mean = c.stepScores.length === 0 ? "—" : c.meanStepScore.toFixed(2);
    lines.push(
      `| ${c.clusterId} | ${c.kind} | ${c.decision} | ${c.lessonPresent ? "yes" : "no"} | ${mean} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e6", "e6-summary.md"), lines);
}
