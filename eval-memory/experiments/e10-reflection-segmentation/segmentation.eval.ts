import { beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE10, type E10Report } from "./runner.js";

/**
 * E10 — Memory Fabric v2.5 Phase B (sliding-window reflection
 * segmentation) integration test.
 *
 * Two scenarios share the same prompt list and total turn count;
 * they differ only on `memory.reflection.segmentation.enabled`.
 * The cadence gate must reduce reflection fires by roughly the
 * `triggerEveryTurns` factor (default 3×).
 *
 * Decision boundaries:
 *  - per-scenario fires within `[min, max]` inclusive
 *  - cadenceRatio (off / on) >= 1.6 (a 3× cadence reduction allows
 *    some flake before this floor is crossed)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_CADENCE_RATIO = envNumber("ATOMIC_AGENT_E10_MIN_CADENCE_RATIO", 1.6);

describe.sequential("E10 — reflection segmentation (v2.5 Phase B)", () => {
  let report: E10Report | null = null;
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
    run = startReportRun({ label: "e10" });
    report = await runE10({ llamaUrl });
    writeE10Reports(run, report);
  }, 1_800_000);

  it("each scenario's fire count lands in the expected band", () => {
    if (skipReason) {
      console.warn(`[E10] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    for (const row of report!.results) {
      expect(
        row.cadenceOk,
        `scenario ${row.id} failed: ${row.failReasons.join("; ")}`,
      ).toBe(true);
    }
  });

  it("cadence gate reduces fire count by at least the configured ratio", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.cadenceRatio,
      "cadenceRatio missing — both on/off scenarios should have produced fires",
    ).not.toBeNull();
    expect(
      report!.aggregate.cadenceRatio!,
      `cadenceRatio=${report!.aggregate.cadenceRatio!.toFixed(2)} below ${MIN_CADENCE_RATIO}`,
    ).toBeGreaterThanOrEqual(MIN_CADENCE_RATIO);
  });

  it("segmentation-on observes at least one fire (deferred segments are still flushed at cadence)", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const onRow = report!.results.find((r) => r.id === "segmentation-on");
    expect(onRow).toBeDefined();
    expect(
      onRow!.reflectionFires,
      "segmentation-on produced zero reflection fires — the cadence gate would also block them, which is wrong",
    ).toBeGreaterThan(0);
  });
});

function writeE10Reports(runRow: ReportRun, report: E10Report): void {
  const jsonlPath = reportPath(runRow, "e10", "e10-results.jsonl");
  appendJsonl(jsonlPath, {
    type: "aggregate",
    ...report.aggregate,
  });
  for (const r of report.results) {
    appendJsonl(jsonlPath, {
      type: "scenario",
      id: r.id,
      label: r.label,
      segmentationEnabled: r.segmentationEnabled,
      promptsExecuted: r.promptsExecuted,
      reflectionFires: r.reflectionFires,
      expectedFiresMin: r.expectedFiresMin,
      expectedFiresMax: r.expectedFiresMax,
      cadenceOk: r.cadenceOk,
      failReasons: r.failReasons,
      durationMs: r.durationMs,
      stderrTail: r.stderrTail,
    });
  }

  writeCsv(
    reportPath(runRow, "e10", "e10-scenarios.csv"),
    [
      "id",
      "segmentationEnabled",
      "promptsExecuted",
      "reflectionFires",
      "expectedMin",
      "expectedMax",
      "ok",
    ] as const,
    report.results.map((r) => ({
      id: r.id,
      segmentationEnabled: r.segmentationEnabled ? "y" : "n",
      promptsExecuted: r.promptsExecuted,
      reflectionFires: r.reflectionFires,
      expectedMin: r.expectedFiresMin,
      expectedMax: r.expectedFiresMax,
      ok: r.cadenceOk ? "y" : "n",
    })),
  );

  const lines: string[] = [
    "# E10 — reflection segmentation (v2.5 Phase B)",
    "",
    `scenarios: ${report.aggregate.scenarios}, passes: ${report.aggregate.passes}, failures: ${report.aggregate.failures}`,
    `cadence ratio (off / on): ${report.aggregate.cadenceRatio === null ? "n/a" : report.aggregate.cadenceRatio.toFixed(2)}`,
    "",
    "## Per scenario",
    "",
    "| id | segmentation | turns | fires | expected | ok |",
    "|---|---|---:|---:|---|---|",
  ];
  for (const r of report.results) {
    lines.push(
      `| ${r.id} | ${r.segmentationEnabled ? "on" : "off"} | ${r.promptsExecuted} | ${r.reflectionFires} | [${r.expectedFiresMin},${r.expectedFiresMax}] | ${r.cadenceOk ? "y" : "n"} |`,
    );
  }
  writeMarkdownSummary(reportPath(runRow, "e10", "e10-summary.md"), lines);
}
