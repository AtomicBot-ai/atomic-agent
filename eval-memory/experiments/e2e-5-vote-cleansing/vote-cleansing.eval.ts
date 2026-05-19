import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE2E5, type E2E5Report } from "./runner.js";

describe.sequential("E2E-5 — vote-driven noise cleansing", () => {
  let report: E2E5Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason = "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e2e.mjs";
      return;
    }
    run = startReportRun({ label: "e2e" });
    report = await runE2E5({ llamaUrl });
    writeReports(run, report);
  }, 1_800_000);

  afterAll(() => undefined);

  it("at least one memory accumulated a positive vote_score", () => {
    if (skipReason) {
      console.warn(`[E2E-5] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.hasPositiveVote,
      `no positive vote_score in any memory; histogram=${JSON.stringify(report!.histogram)}`,
    ).toBe(true);
  });

  it("at least one memory accumulated a negative vote_score", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.hasNegativeVote,
      `no negative vote_score in any memory; histogram=${JSON.stringify(report!.histogram)}`,
    ).toBe(true);
  });
});

function writeReports(run: ReportRun, report: E2E5Report): void {
  const folder = "e2e-5-vote-cleansing";
  const jsonl = reportPath(run, folder, "results.jsonl");
  appendJsonl(jsonl, { type: "summary", ...report });
  appendJsonl(jsonl, { type: "session", ...report.session });
  appendJsonl(jsonl, { type: "consolidator", ...report.consolidator });
  for (const m of report.topUpvoted) appendJsonl(jsonl, { type: "upvoted", ...m });
  for (const m of report.topDownvoted) appendJsonl(jsonl, { type: "downvoted", ...m });

  const lines: string[] = [
    "# E2E-5 — vote-driven noise cleansing",
    "",
    `passed: **${report.passed ? "yes" : "no"}**`,
    `histogram: total=${report.histogram.total}, +=${report.histogram.positive}, -=${report.histogram.negative}, 0=${report.histogram.zero}, max+=${report.histogram.maxPositive}, min-=${report.histogram.minNegative}`,
    "",
    "## Consolidator tick",
    "",
    `kind: ${report.consolidator.kind} | clusters: ${report.consolidator.clustersConsidered} | lessons: ${report.consolidator.lessonsCreated} | procedures: ${report.consolidator.proceduresCreated} | lesson vote-deprecations: ${report.consolidator.memoriesDeprecatedByVote}`,
    "",
    "## Top upvoted memories",
    "",
  ];
  if (report.topUpvoted.length === 0) lines.push("(none)");
  else for (const m of report.topUpvoted) lines.push(`- #${m.id} (score=${m.voteScore}) — ${m.preview}`);

  lines.push("", "## Top downvoted memories", "");
  if (report.topDownvoted.length === 0) lines.push("(none)");
  else for (const m of report.topDownvoted) lines.push(`- #${m.id} (score=${m.voteScore}) — ${m.preview}`);

  lines.push(
    "",
    "## Session",
    "",
    `turns: ${report.session.turnCount}, steps: ${report.session.totalSteps}, duration_ms: ${report.session.totalDurationMs}`,
  );
  writeMarkdownSummary(reportPath(run, folder, "summary.md"), lines);
}
