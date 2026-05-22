import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE7, type E7Report } from "./runner.js";

/**
 * E7 vitest entry. Pure deterministic bench — no LLM, no judge, no
 * managed daemon. Always runnable, never skips.
 *
 * Decision boundaries (env-overridable):
 *  - statusPrecision      >= ATOMIC_AGENT_E7_MIN_STATUS_PRECISION       (default 1.0)
 *  - reasonTallyPrecision >= ATOMIC_AGENT_E7_MIN_REASON_TALLY_PRECISION (default 1.0)
 *  - rerankPrecision      >= ATOMIC_AGENT_E7_MIN_RERANK_PRECISION       (default 1.0)
 *
 * The defaults are deliberately 100% because this is an
 * architectural-correctness bench: any drop is a Phase 6/7a
 * regression worth investigating.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_STATUS = envNumber("ATOMIC_AGENT_E7_MIN_STATUS_PRECISION", 1.0);
const MIN_REASON = envNumber("ATOMIC_AGENT_E7_MIN_REASON_TALLY_PRECISION", 1.0);
const MIN_RERANK = envNumber("ATOMIC_AGENT_E7_MIN_RERANK_PRECISION", 1.0);

describe.sequential("E7 — lesson lifecycle bench", () => {
  let report: E7Report | null = null;
  let run: ReportRun | null = null;

  beforeAll(async () => {
    run = startReportRun({ label: "e7" });
    report = await runE7();
    writeE7Reports(run, report);
  });

  afterAll(() => undefined);

  it("status precision matches the gold map", () => {
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.statusPrecision,
      `statusPrecision=${report!.aggregate.statusPrecision.toFixed(3)} below ${MIN_STATUS}`,
    ).toBeGreaterThanOrEqual(MIN_STATUS);
  });

  it("per-reason tally (vote vs age vs overflow) matches the gold", () => {
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.reasonTallyPrecision,
      `reasonTallyPrecision=${report!.aggregate.reasonTallyPrecision.toFixed(3)} below ${MIN_REASON}`,
    ).toBeGreaterThanOrEqual(MIN_REASON);
  });

  it("rerank ordering under scoreBlend matches the gold order", () => {
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.rerankPrecision,
      `rerankPrecision=${report!.aggregate.rerankPrecision.toFixed(3)} below ${MIN_RERANK}`,
    ).toBeGreaterThanOrEqual(MIN_RERANK);
  });
});

function writeE7Reports(run: ReportRun, report: E7Report): void {
  const jsonlPath = reportPath(run, "e7", "e7-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const sc of report.scenarios) {
    appendJsonl(jsonlPath, {
      type: "scenario",
      scenarioId: sc.scenarioId,
      label: sc.label,
      tick: sc.tick,
      goldTally: sc.goldTally,
      reasonTallyMatched: sc.reasonTallyMatched,
      matchedHandles: sc.matchedHandles,
      mismatchedHandles: sc.mismatchedHandles,
      ...(sc.rerank ? { rerank: sc.rerank } : {}),
    });
    for (const ph of sc.perHandle) appendJsonl(jsonlPath, { type: "handle", scenarioId: sc.scenarioId, ...ph });
  }

  writeCsv(
    reportPath(run, "e7", "e7-handles.csv"),
    ["scenarioId", "handle", "expected", "actual", "matched"] as const,
    report.scenarios.flatMap((sc) =>
      sc.perHandle.map((ph) => ({ scenarioId: sc.scenarioId, ...ph })),
    ),
  );

  const lines: string[] = [
    "# E7 — lesson lifecycle bench",
    "",
    `scenarios: ${report.aggregate.scenarios}, handles: ${report.aggregate.handles}`,
    `status precision        : **${report.aggregate.statusPrecision.toFixed(3)}**`,
    `reason-tally precision  : **${report.aggregate.reasonTallyPrecision.toFixed(3)}**`,
    `rerank precision        : **${report.aggregate.rerankPrecision.toFixed(3)}**`,
    "",
    "## Per scenario",
    "",
    "| scenario | matched / total | tick byVote / byAge | gold byVote / byAge | rerank |",
    "|---|---:|---|---|---|",
  ];
  for (const sc of report.scenarios) {
    const total = sc.matchedHandles + sc.mismatchedHandles;
    const tick = `${sc.tick.byVote} / ${sc.tick.byAge}`;
    const gold = `${sc.goldTally.byVote} / ${sc.goldTally.byAge}`;
    const rerank = sc.rerank ? (sc.rerank.matched ? "ok" : `mismatch (${sc.rerank.produced.join(",")})`) : "—";
    lines.push(`| ${sc.scenarioId} | ${sc.matchedHandles} / ${total} | ${tick} | ${gold} | ${rerank} |`);
  }
  writeMarkdownSummary(reportPath(run, "e7", "e7-summary.md"), lines);
}
