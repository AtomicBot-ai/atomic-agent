#!/usr/bin/env -S npx tsx
/**
 * Aggregate N LoCoMo per-run report directories into a single
 * cross-run aggregate. Spawned by `run-locomo-multi.mjs` after the
 * last run completes; can also be invoked manually to re-aggregate an
 * existing set of runs.
 *
 * Usage:
 *
 *   npx tsx eval-memory/scripts/aggregate-locomo-runs.ts \
 *     --out=<aggregate-dir> \
 *     <run-dir-1> <run-dir-2> <run-dir-3>
 *
 *   --label=<slug>    optional aggregate dir slug (when --out not given,
 *                     created under eval-memory/reports/)
 *
 * Run-dir arguments are absolute paths (or relative to cwd) to the
 * per-run `*-locomo` directories produced by `npm run eval:memory:locomo`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateMultiRun,
  buildAggregatedHeader,
  flattenAggregatedRow,
  type AggregatorRow,
} from "../harness/multi-run-aggregator.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const BASE_NUMERIC_KEYS = [
  "substringAccuracy",
  "abstentionAccuracy",
  "meanPromptTokens",
  "p50PromptTokens",
  "p95PromptTokens",
  "meanDurationMs",
  "p50DurationMs",
  "p95DurationMs",
  "meanStepCount",
] as const;

const JUDGE_NUMERIC_KEYS = [
  "meanJudgeScore",
  "judgeAccAtFour",
  "judgeAccAtFive",
  "graded",
  "judgeAvailable",
] as const;

function log(msg: string): void {
  process.stderr.write(`[locomo-agg] ${msg}\n`);
}

interface CliArgs {
  outDir: string | null;
  label: string | null;
  runDirs: string[];
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { outDir: null, label: null, runDirs: [] };
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (m) {
      const key = m[1];
      const value = m[2] ?? "true";
      if (key === "out") out.outDir = value;
      else if (key === "label") out.label = value;
      continue;
    }
    out.runDirs.push(a);
  }
  return out;
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseCsv(text: string): Array<Record<string, string | number>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((s) => s.trim());
  const out: Array<Record<string, string | number>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(",");
    const row: Record<string, string | number> = {};
    for (let j = 0; j < header.length; j += 1) {
      const raw = (cells[j] ?? "").trim();
      const num = Number(raw);
      row[header[j]!] = raw !== "" && !Number.isNaN(num) ? num : raw;
    }
    out.push(row);
  }
  return out;
}

function loadCsv(
  path: string,
): Array<Record<string, string | number>> | null {
  try {
    return parseCsv(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeAggregateCsv(
  path: string,
  rows: readonly AggregatorRow[],
  identityKeys: ReadonlyArray<string>,
  numericKeys: ReadonlyArray<string>,
): void {
  const header = buildAggregatedHeader(identityKeys, numericKeys);
  const lines = [header.join(",")];
  for (const row of rows) {
    const flat = flattenAggregatedRow(row, identityKeys, numericKeys);
    lines.push(header.map((k) => String(flat[k] ?? "")).join(","));
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(digits);
}

function writeSummaryMd(
  dir: string,
  runDirs: ReadonlyArray<string>,
  baseAgg: readonly AggregatorRow[],
  judgeAgg: readonly AggregatorRow[],
): void {
  const out: string[] = [];
  out.push("# LoCoMo multi-run aggregate", "");
  out.push(`- Runs aggregated: ${runDirs.length}`);
  out.push("- Per-run report dirs:");
  for (const d of runDirs) out.push(`  - ${d}`);
  out.push("");
  out.push("CI bounds are 95% bootstrap intervals computed across runs (sample size = #runs).");
  out.push("With N=3 runs the CI is wide; treat overlapping CIs as 'not separable from noise'.");
  out.push("");
  out.push("## Substring + abstention accuracy by profile × category (mean ± 95% CI)");
  out.push("");
  out.push(
    "| profile | category | runs | substring mean | substring CI | abstain mean | abstain CI |",
  );
  out.push("|---|---|---|---|---|---|---|");
  for (const row of baseAgg) {
    const sub = row.metrics.substringAccuracy!;
    const abs = row.metrics.abstentionAccuracy!;
    out.push(
      `| ${row.identity.profile} | ${row.identity.category} | ${row.contributingRuns} | ` +
        `${fmt(sub.mean)} | [${fmt(sub.ciLow)}, ${fmt(sub.ciHigh)}] | ` +
        `${fmt(abs.mean)} | [${fmt(abs.ciLow)}, ${fmt(abs.ciHigh)}] |`,
    );
  }
  out.push("");
  out.push("## Prompt tokens per question (mean / p50 / p95 across runs)");
  out.push("");
  out.push("| profile | category | runs | meanTokens | p50Tokens | p95Tokens |");
  out.push("|---|---|---|---|---|---|");
  for (const row of baseAgg) {
    const mt = row.metrics.meanPromptTokens!;
    const p50 = row.metrics.p50PromptTokens;
    const p95 = row.metrics.p95PromptTokens;
    out.push(
      `| ${row.identity.profile} | ${row.identity.category} | ${row.contributingRuns} | ` +
        `${fmt(mt.mean, 0)} | ${p50 ? fmt(p50.mean, 0) : "n/a"} | ${p95 ? fmt(p95.mean, 0) : "n/a"} |`,
    );
  }
  out.push("");
  out.push("## Wall-clock per question, ms (mean / p50 / p95 across runs)");
  out.push("");
  out.push("| profile | category | runs | meanMs | p50Ms | p95Ms |");
  out.push("|---|---|---|---|---|---|");
  for (const row of baseAgg) {
    const ms = row.metrics.meanDurationMs!;
    const p50 = row.metrics.p50DurationMs;
    const p95 = row.metrics.p95DurationMs;
    out.push(
      `| ${row.identity.profile} | ${row.identity.category} | ${row.contributingRuns} | ` +
        `${fmt(ms.mean, 0)} | ${p50 ? fmt(p50.mean, 0) : "n/a"} | ${p95 ? fmt(p95.mean, 0) : "n/a"} |`,
    );
  }
  if (judgeAgg.length > 0) {
    out.push("");
    out.push("## LLM judge by profile × category (mean ± 95% CI across runs)");
    out.push("");
    out.push("| profile | category | runs | mean-judge | judge CI | judgeAcc≥4 | judgeAcc=5 |");
    out.push("|---|---|---|---|---|---|---|");
    for (const row of judgeAgg) {
      const mean = row.metrics.meanJudgeScore!;
      const at4 = row.metrics.judgeAccAtFour!;
      const at5 = row.metrics.judgeAccAtFive!;
      out.push(
        `| ${row.identity.profile} | ${row.identity.category} | ${row.contributingRuns} | ` +
          `${fmt(mean.mean)} | [${fmt(mean.ciLow)}, ${fmt(mean.ciHigh)}] | ` +
          `${fmt(at4.mean)} | ${fmt(at5.mean)} |`,
      );
    }
  }
  writeFileSync(resolve(dir, "summary.md"), `${out.join("\n")}\n`, "utf8");
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.runDirs.length === 0) {
    log("at least one run directory required");
    return 2;
  }
  const aggregateDir =
    args.outDir ??
    resolve(
      REPO_ROOT,
      "eval-memory",
      "reports",
      `${nowSlug()}-${args.label ?? "locomo-multi"}-aggregate`,
    );
  mkdirSync(aggregateDir, { recursive: true });

  const baseRuns = args.runDirs
    .map((d) => loadCsv(resolve(d, "by-category.csv")))
    .filter((r): r is Array<Record<string, string | number>> => r !== null);
  if (baseRuns.length === 0) {
    log("no by-category.csv files found in any run dir");
    return 1;
  }
  const baseAgg = aggregateMultiRun({
    runs: baseRuns,
    bucketKey: (row) =>
      `${String(row.profile)}::${String(row.category)}`,
    identityKeys: ["profile", "category"],
    numericKeys: BASE_NUMERIC_KEYS as unknown as string[],
  });
  writeAggregateCsv(
    resolve(aggregateDir, "by-category.csv"),
    baseAgg,
    ["profile", "category"],
    BASE_NUMERIC_KEYS as unknown as string[],
  );

  const judgeRuns = args.runDirs
    .map((d) => loadCsv(resolve(d, "by-category-judge.csv")))
    .filter((r): r is Array<Record<string, string | number>> => r !== null);
  let judgeAgg: AggregatorRow[] = [];
  if (judgeRuns.length > 0) {
    judgeAgg = aggregateMultiRun({
      runs: judgeRuns,
      bucketKey: (row) =>
        `${String(row.profile)}::${String(row.category)}`,
      identityKeys: ["profile", "category"],
      numericKeys: JUDGE_NUMERIC_KEYS as unknown as string[],
    });
    writeAggregateCsv(
      resolve(aggregateDir, "by-category-judge.csv"),
      judgeAgg,
      ["profile", "category"],
      JUDGE_NUMERIC_KEYS as unknown as string[],
    );
  } else {
    log("no by-category-judge.csv files found — skipping judge aggregate");
  }

  writeSummaryMd(aggregateDir, args.runDirs, baseAgg, judgeAgg);
  log(`aggregate written to ${aggregateDir}`);
  return 0;
}

process.exit(main());
