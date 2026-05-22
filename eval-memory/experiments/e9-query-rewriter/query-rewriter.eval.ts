import { beforeAll, describe, expect, it } from "vitest";

import { createLlmComplete } from "../../harness/llm-client.js";
import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE9, type E9Report } from "./runner.js";

/**
 * E9 — Memory Fabric v2.5 Phase A (heuristic-gated query rewriter)
 * integration tests against a managed llama-server.
 *
 * Decision-boundary asserts:
 *  - outcomeMatchRate         >= ATOMIC_AGENT_E9_MIN_OUTCOME_MATCH (default 0.75)
 *  - passRate                 >= ATOMIC_AGENT_E9_MIN_PASS_RATE     (default 0.70)
 *  - slotInvariantViolations  == 0 (hard — slot=-1 is load-bearing)
 *
 * The "ok" cases depend on the live model producing a reasonable
 * rewrite; on a 9B model that is high-variance. The default floors
 * are intentionally permissive — same posture as E5.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_OUTCOME_MATCH = envNumber("ATOMIC_AGENT_E9_MIN_OUTCOME_MATCH", 0.75);
const MIN_PASS_RATE = envNumber("ATOMIC_AGENT_E9_MIN_PASS_RATE", 0.7);

describe.sequential("E9 — query rewriter (v2.5 Phase A)", () => {
  let report: E9Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason =
        "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-v25.mjs";
      return;
    }
    const llmComplete = createLlmComplete({
      baseUrl: llamaUrl,
      timeoutMs: 60_000,
    });
    run = startReportRun({ label: "e9" });
    report = await runE9({ llmComplete });
    writeE9Reports(run, report);
  });

  it("outcome match rate clears the floor", () => {
    if (skipReason) {
      console.warn(`[E9] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.outcomeMatchRate,
      `outcomeMatchRate=${report!.aggregate.outcomeMatchRate.toFixed(3)} below ${MIN_OUTCOME_MATCH}`,
    ).toBeGreaterThanOrEqual(MIN_OUTCOME_MATCH);
  });

  it("pass rate clears the floor", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.passRate,
      `passRate=${report!.aggregate.passRate.toFixed(3)} below ${MIN_PASS_RATE}`,
    ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
  });

  it("slot invariant holds (rewriter always pins slot=-1)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.slotInvariantViolations,
      "rewriter took a slot other than -1; load-bearing invariant breached",
    ).toBe(0);
  });

  it("heuristic-gated skip cases never reach the LLM", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const skipRows = report!.cases.filter(
      (c) =>
        c.expectedOutcome === "skipped_not_referential" ||
        c.expectedOutcome === "skipped_no_history",
    );
    expect(skipRows.length).toBeGreaterThan(0);
    for (const row of skipRows) {
      expect(
        row.observedOutcome,
        `case ${row.caseId} expected gate skip, observed ${row.observedOutcome}`,
      ).toBe(row.expectedOutcome);
      expect(
        row.rewritten,
        `case ${row.caseId} expected raw message preserved when gate skips`,
      ).toBe(row.rawMessage);
    }
  });

  it("malformed stubs surface as outcome=failed and fall back to raw", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const stubRows = report!.cases.filter((c) => c.mode === "stub");
    expect(stubRows.length).toBeGreaterThan(0);
    for (const row of stubRows) {
      expect(
        row.observedOutcome,
        `stub case ${row.caseId} should yield outcome=failed`,
      ).toBe("failed");
      expect(
        row.rewritten,
        `stub case ${row.caseId} should preserve the raw message on parse failure`,
      ).toBe(row.rawMessage);
    }
  });

  it("timeout cases surface as outcome=timeout and fall back to raw", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const tRows = report!.cases.filter((c) => c.mode === "timeout");
    expect(tRows.length).toBeGreaterThan(0);
    for (const row of tRows) {
      expect(
        row.observedOutcome,
        `timeout case ${row.caseId} should yield outcome=timeout`,
      ).toBe("timeout");
      expect(
        row.rewritten,
        `timeout case ${row.caseId} should preserve the raw message`,
      ).toBe(row.rawMessage);
    }
  });
});

function writeE9Reports(runRow: ReportRun, report: E9Report): void {
  const jsonlPath = reportPath(runRow, "e9", "e9-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const c of report.cases) {
    appendJsonl(jsonlPath, {
      type: "case",
      caseId: c.caseId,
      label: c.label,
      mode: c.mode,
      expectedOutcome: c.expectedOutcome,
      observedOutcome: c.observedOutcome,
      pass: c.pass,
      failReasons: c.failReasons,
      durationMs: c.durationMs,
      slotIdSeen: c.slotIdSeen,
      rewritten: c.rewritten,
      rawMessage: c.rawMessage,
    });
  }

  writeCsv(
    reportPath(runRow, "e9", "e9-cases.csv"),
    [
      "caseId",
      "mode",
      "expected",
      "observed",
      "pass",
      "durationMs",
      "slotIdSeen",
    ] as const,
    report.cases.map((c) => ({
      caseId: c.caseId,
      mode: c.mode,
      expected: c.expectedOutcome,
      observed: c.observedOutcome,
      pass: c.pass ? "y" : "n",
      durationMs: c.durationMs,
      slotIdSeen: c.slotIdSeen,
    })),
  );

  const lines: string[] = [
    "# E9 — query rewriter (v2.5 Phase A)",
    "",
    `cases: ${report.aggregate.cases}, passes: ${report.aggregate.passes}, failures: ${report.aggregate.failures}`,
    `outcome match rate : **${report.aggregate.outcomeMatchRate.toFixed(3)}**`,
    `pass rate          : **${report.aggregate.passRate.toFixed(3)}**`,
    `slot violations    : ${report.aggregate.slotInvariantViolations}`,
    "",
    "## Per case",
    "",
    "| case | mode | expected | observed | pass | rewrite preview |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of report.cases) {
    const preview =
      c.rewritten === c.rawMessage
        ? "(raw preserved)"
        : c.rewritten.slice(0, 80).replace(/\|/g, "\\|");
    lines.push(
      `| ${c.caseId} | ${c.mode} | ${c.expectedOutcome} | ${c.observedOutcome} | ${c.pass ? "y" : "n"} | ${preview} |`,
    );
  }
  writeMarkdownSummary(reportPath(runRow, "e9", "e9-summary.md"), lines);
}
