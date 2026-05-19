import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE2E1, type E2E1Report } from "./runner.js";

describe.sequential("E2E-1 — profile recall across silence", () => {
  let report: E2E1Report | null = null;
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
    report = await runE2E1({ llamaUrl });
    writeE2E1Reports(run, report);
  }, 900_000);

  afterAll(() => undefined);

  it("session 1 wrote at least one profile fact", () => {
    if (skipReason) {
      console.warn(`[E2E-1] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.profileFactsAfterS1,
      `profile_facts after S1 = ${report!.profileFactsAfterS1}; reflection did not extract any fact`,
    ).toBeGreaterThan(0);
  });

  it("session 2 reuses the deploy command without re-asking", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.substringInS2,
      `S2 reply did not contain '${report!.expectedSubstring}'\n` +
        `lastReply: ${report!.sessions[1]?.lastReply ?? "(no reply)"}`,
    ).toBe(true);
  });

  it("session 3 also reuses the deploy command", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.substringInS3,
      `S3 reply did not contain '${report!.expectedSubstring}'\n` +
        `lastReply: ${report!.sessions[2]?.lastReply ?? "(no reply)"}`,
    ).toBe(true);
  });
});

function writeE2E1Reports(run: ReportRun, report: E2E1Report): void {
  const folder = "e2e-1-profile-recall";
  const jsonl = reportPath(run, folder, "results.jsonl");
  appendJsonl(jsonl, { type: "summary", ...report });
  for (const s of report.sessions) appendJsonl(jsonl, { type: "session", ...s });

  const lines: string[] = [
    "# E2E-1 — profile recall across silence",
    "",
    `passed: **${report.passed ? "yes" : "no"}**`,
    `expected substring: \`${report.expectedSubstring}\``,
    `profile_facts after S1: ${report.profileFactsAfterS1}`,
    `substring in S2: ${report.substringInS2 ? "yes" : "no"}`,
    `substring in S3: ${report.substringInS3 ? "yes" : "no"}`,
    "",
    "## Sessions",
    "",
    "| label | turns | steps | duration_ms | substring | last reply (first 200 chars) |",
    "|---|---:|---:|---:|:---:|---|",
  ];
  for (const s of report.sessions) {
    const preview = s.lastReply.slice(0, 200).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(
      `| ${s.label} | ${s.turnCount} | ${s.totalSteps} | ${s.totalDurationMs} | ${s.replyHasSubstring ? "yes" : "no"} | ${preview} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, folder, "summary.md"), lines);
}
