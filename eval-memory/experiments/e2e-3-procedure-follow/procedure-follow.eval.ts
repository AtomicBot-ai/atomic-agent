import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE2E3, type E2E3Report } from "./runner.js";

describe.sequential("E2E-3 — procedure-follow on similar task", () => {
  let report: E2E3Report | null = null;
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
    report = await runE2E3({ llamaUrl });
    writeReports(run, report);
  }, 1_800_000);

  afterAll(() => undefined);

  it("consolidator emitted at least one procedure after S3", () => {
    if (skipReason) {
      console.warn(`[E2E-3] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.proceduresAfterConsolidate,
      `procedures table = ${report!.proceduresAfterConsolidate}; consolidator: ${report!.consolidator.kind} (lessons=${report!.consolidator.lessonsCreated}, procedures=${report!.consolidator.proceduresCreated})`,
    ).toBeGreaterThan(0);
  });

  it("at least one stored procedure references the expected tools", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.procedureMatchesToolHints,
      `none of the stored procedures' tool hints matched ${report!.expectedToolHints.join("/")}`,
    ).toBe(true);
  });

  it("S4 exercises the persisted procedure (recall call or reply keywords)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const s4 = report!.sessions.find((s) => s.label === "S4");
    const signalHit =
      report!.s4CalledProcedureRecall || report!.s4MentionsKeywords;
    expect(
      signalHit,
      `S4 did not exercise the procedure:\n  memory.procedures.recall called: ${report!.s4CalledProcedureRecall}\n  reply keywords matched (${report!.s4ReplyKeywords.join("/")}): ${report!.s4MentionsKeywords}\n  toolCalls: ${(s4?.toolCallNames ?? []).join(", ")}\n  lastReply: ${s4?.lastReply ?? "(none)"}`,
    ).toBe(true);
  });
});

function writeReports(run: ReportRun, report: E2E3Report): void {
  const folder = "e2e-3-procedure-follow";
  const jsonl = reportPath(run, folder, "results.jsonl");
  appendJsonl(jsonl, { type: "summary", ...report });
  for (const s of report.sessions) appendJsonl(jsonl, { type: "session", ...s });
  appendJsonl(jsonl, { type: "consolidator", ...report.consolidator });

  const lines: string[] = [
    "# E2E-3 — procedure-follow on similar task",
    "",
    `passed: **${report.passed ? "yes" : "no"}**`,
    `procedures after consolidate: ${report.proceduresAfterConsolidate}`,
    `procedure has expected tool hint: ${report.procedureMatchesToolHints ? "yes" : "no"}`,
    `S4 reply mentions ${report.s4ReplyKeywords.join("/")}: ${report.s4MentionsKeywords ? "yes" : "no"}`,
    `S4 called memory.procedures.recall: ${report.s4CalledProcedureRecall ? "yes" : "no"}`,
    "",
    "## Consolidator tick",
    "",
    `kind: ${report.consolidator.kind} | clusters: ${report.consolidator.clustersConsidered} | lessons: ${report.consolidator.lessonsCreated} | procedures: ${report.consolidator.proceduresCreated}`,
    report.consolidator.reason ? `reason: ${report.consolidator.reason}` : "",
    "",
    "## Stored procedures",
    "",
  ];
  if (report.storedProcedures.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of report.storedProcedures) {
      lines.push(`- activation: \`${p.activation}\``);
      for (const s of p.steps)
        lines.push(`    - step: ${s.description} (tool=${s.toolHint ?? "—"})`);
    }
  }
  lines.push("", "## Sessions", "", "| label | turns | steps | duration_ms | tool calls |", "|---|---:|---:|---:|---|");
  for (const s of report.sessions) {
    const tools = s.toolCallNames.slice(0, 6).join(", ");
    lines.push(`| ${s.label} | ${s.turnCount} | ${s.totalSteps} | ${s.totalDurationMs} | ${tools} |`);
  }
  writeMarkdownSummary(reportPath(run, folder, "summary.md"), lines);
}
