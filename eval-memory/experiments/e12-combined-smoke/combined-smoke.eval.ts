import { beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE12, type E12Report } from "./runner.js";

/**
 * E12 — "all three on" combined smoke test against the live
 * managed daemon. Asserts that the v2.5 surfaces co-exist without
 * crashing and that each phase produced at least one observable
 * signal in a mixed 18-turn session.
 */

describe.sequential("E12 — combined all-three-on smoke (v2.5)", () => {
  let report: E12Report | null = null;
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
    run = startReportRun({ label: "e12" });
    report = await runE12({ llamaUrl });
    writeE12Reports(run, report);
  }, 30 * 60 * 1000);

  it("the combined session runs end-to-end without crashing", () => {
    if (skipReason) {
      console.warn(`[E12] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    const r = report!.result;
    expect(
      r.ok,
      `smoke scenario failed: ${r.failReasons.join("; ")}`,
    ).toBe(true);
  });

  it("each Phase produced at least one observable signal", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const r = report!.result;
    expect(
      r.reflectionFires,
      "Phase B (segmentation) emitted zero reflection.fired events",
    ).toBeGreaterThan(0);
    expect(
      r.rewriterAttempts,
      "Phase A (rewriter) never reached the LLM despite referential follow-ups in the dataset",
    ).toBeGreaterThan(0);
    expect(
      r.typeTagsObserved.length,
      "Phase C (typed notes) produced zero type:* tags in memories.tags",
    ).toBeGreaterThan(0);
  });
});

function writeE12Reports(runRow: ReportRun, report: E12Report): void {
  const jsonlPath = reportPath(runRow, "e12", "e12-results.jsonl");
  appendJsonl(jsonlPath, { type: "result", ...report.result });

  const r = report.result;
  const lines: string[] = [
    "# E12 — combined all-three-on smoke (v2.5)",
    "",
    `scenario: ${r.scenarioId}`,
    `outcome: ${r.ok ? "pass" : "fail"}`,
    `prompts: ${r.promptsExecuted}, exit code: ${r.exitCode ?? "n/a"}`,
    `reflection.fired: **${r.reflectionFires}**, rewriter.ok: **${r.rewriterFires}**, rewriter attempts: ${r.rewriterAttempts}`,
    `memories: ${r.rowsAfter}, type tags observed: ${r.typeTagsObserved.join(", ") || "(none)"}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)} s`,
  ];
  if (!r.ok) {
    lines.push("", "## Failures", "");
    for (const reason of r.failReasons) lines.push(`- ${reason}`);
  }
  writeMarkdownSummary(reportPath(runRow, "e12", "e12-summary.md"), lines);
}
