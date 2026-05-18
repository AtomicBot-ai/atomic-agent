import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeCsv,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";
import { runE1, type E1Mode, type E1Report } from "./runner.js";

/**
 * E1 vitest entrypoint. The same spec runs both the offline floor
 * (BM25-only, no env vars) and the full hybrid sweep (env-driven).
 *
 * Env knobs honoured here:
 *
 *  - `ATOMIC_AGENT_EVAL_EMBED_URL`   — embedding daemon base URL.
 *    When present + reachable, hybrid + hybrid+links modes run.
 *  - `ATOMIC_AGENT_EVAL_EMBED_DIM`   — embedding dim (required when
 *    EMBED_URL is set).
 *  - `ATOMIC_AGENT_EVAL_EMBED_MODEL` — embedding model id (recorded).
 *  - `ATOMIC_AGENT_E1_MIN_PRECISION_AT_5` — hybrid P@5 floor (default 0.6).
 *  - `ATOMIC_AGENT_E1_MIN_HYBRID_DELTA`   — required hybrid - bm25
 *    delta (default 0.05).
 *
 * The companion `scripts/run-e1.mjs` brings up the embedding daemon
 * via `atomic-agent models start` and forwards these env vars in;
 * running this spec via raw vitest is the BM25-only floor mode.
 */

const TOP_K = 5;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readHybridParams():
  | { url: string; dim: number; model: string }
  | null {
  const url = process.env.ATOMIC_AGENT_EVAL_EMBED_URL;
  if (!url) return null;
  const dim = Number(process.env.ATOMIC_AGENT_EVAL_EMBED_DIM ?? "");
  if (!Number.isInteger(dim) || dim <= 0) return null;
  const model = process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL ?? "unknown";
  return { url, dim, model };
}

const MIN_PRECISION_BM25_OVERALL = 0.45;
const MIN_PRECISION_BM25_EASY = 0.7;
const MIN_HYBRID_P5 = envNumber("ATOMIC_AGENT_E1_MIN_PRECISION_AT_5", 0.6);
const MIN_HYBRID_DELTA = envNumber("ATOMIC_AGENT_E1_MIN_HYBRID_DELTA", 0.05);

describe.sequential("E1 — recall precision", () => {
  let report: E1Report;
  let run: ReportRun;
  let hybridParamsAvailable: boolean;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const hybridParams = readHybridParams();
    hybridParamsAvailable = hybridParams !== null;
    const modes: readonly E1Mode[] = hybridParamsAvailable
      ? ["bm25-only", "hybrid", "hybrid+links"]
      : ["bm25-only"];
    run = startReportRun({ label: hybridParamsAvailable ? "e1-full" : "e1-bm25-only" });
    report = await runE1({
      topK: TOP_K,
      modes,
      ...(hybridParams ? {
        embeddingUrl: hybridParams.url,
        embeddingDim: hybridParams.dim,
        embeddingModel: hybridParams.model,
      } : {}),
    });
    writeE1Reports(run, report);
  });

  afterAll(() => undefined);

  it("returns at most top-K results per query", () => {
    for (const r of report.perQuery) {
      expect(r.hits.length, `query ${r.queryId} returned more than topK hits`).toBeLessThanOrEqual(TOP_K);
    }
  });

  it("BM25-only meets the overall precision floor", () => {
    const overall = aggregate(report, "bm25-only", "all");
    expect(overall, "missing overall aggregate row").toBeDefined();
    expect(
      overall!.precisionMean,
      `overall BM25 P@${TOP_K}=${overall!.precisionMean.toFixed(3)} below ${MIN_PRECISION_BM25_OVERALL}`,
    ).toBeGreaterThanOrEqual(MIN_PRECISION_BM25_OVERALL);
  });

  it("BM25-only handles easy paraphrases", () => {
    const easy = aggregate(report, "bm25-only", "easy");
    expect(easy, "missing easy aggregate row").toBeDefined();
    expect(
      easy!.precisionMean,
      `easy BM25 P@${TOP_K}=${easy!.precisionMean.toFixed(3)} below ${MIN_PRECISION_BM25_EASY}`,
    ).toBeGreaterThanOrEqual(MIN_PRECISION_BM25_EASY);
  });

  it("hybrid meets P@5 floor (skipped without embedding daemon)", () => {
    if (!hybridParamsAvailable) return;
    const overall = aggregate(report, "hybrid", "all");
    expect(overall, "hybrid aggregate missing although embedding params set").toBeDefined();
    expect(
      overall!.precisionMean,
      `hybrid P@${TOP_K}=${overall!.precisionMean.toFixed(3)} below ${MIN_HYBRID_P5}`,
    ).toBeGreaterThanOrEqual(MIN_HYBRID_P5);
  });

  it("hybrid beats BM25 by the minimum delta (skipped without embedding daemon)", () => {
    if (!hybridParamsAvailable) return;
    const bm25 = aggregate(report, "bm25-only", "all");
    const hybrid = aggregate(report, "hybrid", "all");
    expect(bm25).toBeDefined();
    expect(hybrid).toBeDefined();
    const delta = hybrid!.precisionMean - bm25!.precisionMean;
    expect(
      delta,
      `hybrid - bm25 delta=${delta.toFixed(3)} below ${MIN_HYBRID_DELTA}; hybrid does not beat BM25`,
    ).toBeGreaterThanOrEqual(MIN_HYBRID_DELTA);
  });

  it("hybrid+links does not regress vs hybrid (skipped without embedding daemon)", () => {
    if (!hybridParamsAvailable) return;
    const hybrid = aggregate(report, "hybrid", "all");
    const withLinks = aggregate(report, "hybrid+links", "all");
    expect(hybrid).toBeDefined();
    expect(withLinks).toBeDefined();
    expect(
      withLinks!.precisionMean,
      `hybrid+links P@${TOP_K}=${withLinks!.precisionMean.toFixed(3)} regressed vs hybrid ${hybrid!.precisionMean.toFixed(3)}`,
    ).toBeGreaterThanOrEqual(hybrid!.precisionMean - 0.01);
  });
});

function aggregate(report: E1Report, mode: E1Mode, difficulty: string) {
  return report.aggregates.find((a) => a.mode === mode && a.difficulty === difficulty);
}

function writeE1Reports(run: ReportRun, report: E1Report): void {
  const jsonlPath = reportPath(run, "e1", "e1-results.jsonl");
  appendJsonl(jsonlPath, {
    type: "summary",
    topK: report.topK,
    modesRun: report.modesRun,
    modesSkipped: report.modesSkipped,
    clusterSizes: report.clusterSizes,
  });
  for (const r of report.perQuery) appendJsonl(jsonlPath, r);

  writeCsv(
    reportPath(run, "e1", "e1-results.csv"),
    ["queryId", "clusterId", "difficulty", "mode", "precision", "recall", "mrr", "hits", "hitClusters"] as const,
    report.perQuery.map((r) => ({
      ...r,
      hits: r.hits.join("|"),
      hitClusters: r.hitClusters.join("|"),
    })),
  );

  const lines: string[] = [
    "# E1 — recall precision",
    "",
    `top-K = ${report.topK}`,
    `modes run: ${report.modesRun.join(", ")}`,
    report.modesSkipped.length
      ? `modes skipped: ${report.modesSkipped.map((s) => `${s.mode} (${s.reason})`).join("; ")}`
      : "modes skipped: none",
    "",
    "## Aggregates",
    "",
    "| mode | difficulty | n | P@K | R@K | MRR |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const a of report.aggregates) {
    lines.push(
      `| ${a.mode} | ${a.difficulty} | ${a.queries} | ${a.precisionMean.toFixed(3)} | ${a.recallMean.toFixed(3)} | ${a.mrrMean.toFixed(3)} |`,
    );
  }
  writeMarkdownSummary(reportPath(run, "e1", "e1-summary.md"), lines);
}
