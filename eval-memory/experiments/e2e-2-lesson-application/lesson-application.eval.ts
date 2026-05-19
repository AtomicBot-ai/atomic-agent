import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE2E2, type E2E2Report } from "./runner.js";

describe.sequential("E2E-2 — lesson distillation → application", () => {
  let report: E2E2Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason =
        "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-e2e.mjs";
      return;
    }
    run = startReportRun({ label: "e2e" });
    report = await runE2E2({ llamaUrl });
    writeReports(run, report);
  }, 2_700_000);

  afterAll(() => undefined);

  it("S1+S2 stored at least 6 episodes via memory.notes.store", () => {
    if (skipReason) {
      console.warn(`[E2E-2] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.memoriesAfterS2,
      `memories after S2 = ${report!.memoriesAfterS2} (expected >= 6)`,
    ).toBeGreaterThanOrEqual(6);
  });

  it("consolidator distilled at least one lesson from the cluster", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.lessonsAfterConsolidate,
      `lessons table = ${report!.lessonsAfterConsolidate}; consolidator: ${report!.consolidator.kind} (${report!.consolidator.clustersConsidered} clusters considered)`,
    ).toBeGreaterThan(0);
  });

  it("distilled lesson body mentions the recipe keywords", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.lessonBodyMatchesKeywords,
      `no lesson body mentioned all keywords; lessons after: ${report!.lessonsAfterConsolidate}; hits: ${JSON.stringify(
        report!.lessonHits,
      )}`,
    ).toBe(true);
  });

  it("S3 reply references the lesson's recipe (.eslintignore)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.s3ReplyHasSubstring,
      `S3 reply missing '${report!.expectedSubstring}'\nlastReply: ${
        report!.sessions.find((s) => s.label === "S3")?.lastReply ?? "(none)"
      }`,
    ).toBe(true);
  });
});

function writeReports(run: ReportRun, report: E2E2Report): void {
  const folder = "e2e-2-lesson-application";
  const jsonl = reportPath(run, folder, "results.jsonl");
  appendJsonl(jsonl, { type: "summary", ...report });
  for (const s of report.sessions) appendJsonl(jsonl, { type: "session", ...s });
  appendJsonl(jsonl, { type: "consolidator", ...report.consolidator });

  const lines: string[] = [
    "# E2E-2 — lesson distillation → application",
    "",
    `passed: **${report.passed ? "yes" : "no"}**`,
    `memories after S2: ${report.memoriesAfterS2}`,
    `lessons after consolidate: ${report.lessonsAfterConsolidate}`,
    `lesson keyword match: ${report.lessonBodyMatchesKeywords ? "yes" : "no"}`,
    `S3 reply has '${report.expectedSubstring}': ${report.s3ReplyHasSubstring ? "yes" : "no"}`,
    "",
    "## Consolidator tick",
    "",
    `kind: ${report.consolidator.kind} | clusters: ${report.consolidator.clustersConsidered} | lessons created: ${report.consolidator.lessonsCreated} | procedures: ${report.consolidator.proceduresCreated}`,
    report.consolidator.reason ? `reason: ${report.consolidator.reason}` : "",
    "",
    "## Distilled lesson(s)",
    "",
    "| activation (first 120 chars) | principle (first 120 chars) |",
    "|---|---|",
  ];
  for (const h of report.lessonHits) {
    const a = h.activation.slice(0, 120).replace(/\|/g, "\\|").replace(/\n/g, " ");
    const p = h.principle.slice(0, 120).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${a} | ${p} |`);
  }
  lines.push("", "## Sessions", "");
  lines.push("| label | turns | steps | duration_ms | last reply (first 200) |");
  lines.push("|---|---:|---:|---:|---|");
  for (const s of report.sessions) {
    const preview = s.lastReply
      .slice(0, 200)
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
    lines.push(
      `| ${s.label} | ${s.turnCount} | ${s.totalSteps} | ${s.totalDurationMs} | ${preview} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, folder, "summary.md"), lines);
}
