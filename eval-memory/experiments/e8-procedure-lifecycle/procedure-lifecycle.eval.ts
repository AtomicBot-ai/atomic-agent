import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE8, type E8Report } from "./runner.js";

/**
 * E8 vitest entry. Pure deterministic bench — no LLM, no judge.
 * Locks the Phase 7b procedure lifecycle contract (vote/age/overflow
 * deprecation, lesson→procedure cascade, vote-aware recall rerank).
 *
 * Decision boundaries (env-overridable):
 *  - statusPrecision      >= ATOMIC_AGENT_E8_MIN_STATUS_PRECISION       (default 1.0)
 *  - reasonTallyPrecision >= ATOMIC_AGENT_E8_MIN_REASON_TALLY_PRECISION (default 1.0)
 *  - rerankPrecision      >= ATOMIC_AGENT_E8_MIN_RERANK_PRECISION       (default 1.0)
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_STATUS = envNumber("ATOMIC_AGENT_E8_MIN_STATUS_PRECISION", 1.0);
const MIN_REASON = envNumber("ATOMIC_AGENT_E8_MIN_REASON_TALLY_PRECISION", 1.0);
const MIN_RERANK = envNumber("ATOMIC_AGENT_E8_MIN_RERANK_PRECISION", 1.0);

describe.sequential("E8 — procedure lifecycle bench", () => {
  let report: E8Report | null = null;
  let run: ReportRun | null = null;

  beforeAll(async () => {
    run = startReportRun({ label: "e8" });
    report = await runE8();
    writeE8Reports(run, report);
  });

  afterAll(() => undefined);

  it("status precision matches the gold map", () => {
    expect(report).not.toBeNull();
    expect(
      report!.aggregate.statusPrecision,
      `statusPrecision=${report!.aggregate.statusPrecision.toFixed(3)} below ${MIN_STATUS}`,
    ).toBeGreaterThanOrEqual(MIN_STATUS);
  });

  it("per-reason tally (vote vs age vs overflow vs cascade) matches the gold", () => {
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

function writeE8Reports(run: ReportRun, report: E8Report): void {
  const jsonlPath = reportPath(run, "e8", "e8-results.jsonl");
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
    for (const ph of sc.perHandle)
      appendJsonl(jsonlPath, { type: "handle", scenarioId: sc.scenarioId, ...ph });
  }

  writeCsv(
    reportPath(run, "e8", "e8-handles.csv"),
    ["scenarioId", "handle", "expected", "actual", "matched"] as const,
    report.scenarios.flatMap((sc) =>
      sc.perHandle.map((ph) => ({ scenarioId: sc.scenarioId, ...ph })),
    ),
  );

  const lines: string[] = [
    "# E8 — procedure lifecycle bench (phase 7b)",
    "",
    `scenarios: ${report.aggregate.scenarios}, handles: ${report.aggregate.handles}`,
    `status precision        : **${report.aggregate.statusPrecision.toFixed(3)}**`,
    `reason-tally precision  : **${report.aggregate.reasonTallyPrecision.toFixed(3)}**`,
    `rerank precision        : **${report.aggregate.rerankPrecision.toFixed(3)}**`,
    "",
    "## Per scenario",
    "",
    "| scenario | matched / total | tick V/A/O/C | gold V/A/O/C | rerank |",
    "|---|---:|---|---|---|",
  ];
  for (const sc of report.scenarios) {
    const total = sc.matchedHandles + sc.mismatchedHandles;
    const tick = `${sc.tick.byVote}/${sc.tick.byAge}/${sc.tick.byOverflow}/${sc.tick.byCascade}`;
    const gold = `${sc.goldTally.byVote}/${sc.goldTally.byAge}/${sc.goldTally.byOverflow}/${sc.goldTally.byCascade}`;
    const rerank = sc.rerank
      ? sc.rerank.matched
        ? "ok"
        : `mismatch (${sc.rerank.produced.join(",")})`
      : "—";
    lines.push(
      `| ${sc.scenarioId} | ${sc.matchedHandles} / ${total} | ${tick} | ${gold} | ${rerank} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e8", "e8-summary.md"), lines);
}
