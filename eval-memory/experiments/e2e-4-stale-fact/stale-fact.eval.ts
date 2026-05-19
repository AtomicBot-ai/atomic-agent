import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE2E4, type E2E4Report } from "./runner.js";

describe.sequential("E2E-4 — stale fact correction (bi-temporal)", () => {
  let report: E2E4Report | null = null;
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
    report = await runE2E4({ llamaUrl });
    writeReports(run, report);
  }, 900_000);

  afterAll(() => undefined);

  it("profile holds the NEW value after the correction in S2", () => {
    if (skipReason) {
      console.warn(`[E2E-4] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.profileHoldsNewValue,
      `no profile_facts row mentioned ${report!.newValueSubstrings.join("/")}; rows: ${JSON.stringify(report!.profileRowsAfterS2)}`,
    ).toBe(true);
  });

  it("profile no longer holds the stale value", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.profileFreeOfStale,
      `profile rows still contain stale ${report!.staleSubstrings.join("/")}: ${JSON.stringify(report!.profileRowsAfterS2)}`,
    ).toBe(true);
  });

  it("S3 reply uses the new value and avoids the stale one", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.s3ReplyMentionsNewOnly,
      `S3 reply did not cleanly switch to ${report!.newValueSubstrings.join("/")} (or still mentions ${report!.staleSubstrings.join("/")})\nreply: ${report!.s3Reply}`,
    ).toBe(true);
  });
});

function writeReports(run: ReportRun, report: E2E4Report): void {
  const folder = "e2e-4-stale-fact";
  const jsonl = reportPath(run, folder, "results.jsonl");
  appendJsonl(jsonl, { type: "summary", ...report });
  for (const s of report.sessions) appendJsonl(jsonl, { type: "session", ...s });

  const lines: string[] = [
    "# E2E-4 — stale fact correction (bi-temporal)",
    "",
    `passed: **${report.passed ? "yes" : "no"}**`,
    `profile holds new value: ${report.profileHoldsNewValue ? "yes" : "no"}`,
    `profile free of stale: ${report.profileFreeOfStale ? "yes" : "no"}`,
    `S3 cleanly uses new only: ${report.s3ReplyMentionsNewOnly ? "yes" : "no"}`,
    "",
    "## Profile rows after S2",
    "",
  ];
  if (report.profileRowsAfterS2.length === 0) lines.push("(empty)");
  else for (const r of report.profileRowsAfterS2) lines.push(`- \`${r.key}\` = \`${r.value}\``);
  lines.push("", "## Sessions", "", "| label | turns | steps | duration_ms | last reply (first 200) |", "|---|---:|---:|---:|---|");
  for (const s of report.sessions) {
    const preview = s.lastReply.slice(0, 200).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${s.label} | ${s.turnCount} | ${s.totalSteps} | ${s.totalDurationMs} | ${preview} |`);
  }
  writeMarkdownSummary(reportPath(run, folder, "summary.md"), lines);
}
