#!/usr/bin/env tsx
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createJudgeClient,
  loadJudgeConfigFromEnv,
} from "../harness/judge-client.js";
import type { JudgeClient } from "../harness/judge-types.js";

/**
 * `npm run eval:judge [-- --run path/to/run.jsonl] [--out path/to/out.csv]`
 *
 * Re-scores the assistant replies stored in a previous eval JSONL
 * sidecar. This lets you (a) try a stronger judge on a saved run
 * without re-spawning the agent, (b) iterate on rubrics without paying
 * for a full eval cycle.
 *
 * Defaults:
 *   --run     newest *.jsonl in eval/reports/
 *   --out     <run>.judge.csv
 *
 * Output CSV: case_id, expectation_index, score, threshold, passed,
 *             duration_ms, parse_fallback, reason
 */

interface JudgeExpectationSummary {
  kind: string;
  rubric?: string;
  threshold?: number;
}

interface JsonlRecord {
  case: { id: string; prompt: string };
  run: { reply: string; skipped: boolean };
  expectations: JudgeExpectationSummary[];
}

interface JudgeRow {
  caseId: string;
  index: number;
  score: number | null;
  threshold: number;
  passed: boolean;
  durationMs: number;
  parseFallback: boolean;
  reason: string;
}

const HEADER = [
  "case_id",
  "expectation_index",
  "score",
  "threshold",
  "passed",
  "duration_ms",
  "parse_fallback",
  "reason",
].join(",");

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const runPath = opts.run ?? findLatestJsonl();
  if (!runPath) {
    process.stderr.write(
      "no run JSONL found. Run `npm run eval` first or pass --run <path>.\n",
    );
    return 2;
  }
  if (!existsSync(runPath)) {
    process.stderr.write(`run JSONL not found: ${runPath}\n`);
    return 2;
  }
  const outPath = opts.out ?? defaultOutPath(runPath);

  const judgeConfig = loadJudgeConfigFromEnv();
  if (!judgeConfig) {
    process.stderr.write(
      "judge disabled. Set OPENROUTER_API_KEY (default OpenRouter judge) or override ATOMIC_AGENT_JUDGE_URL, and unset ATOMIC_AGENT_JUDGE_DISABLED.\n",
    );
    return 2;
  }
  const judge = createJudgeClient(judgeConfig);

  writeFileSync(outPath, `${HEADER}\n`, "utf8");
  let totalCases = 0;
  let totalJudged = 0;
  let totalPassed = 0;

  for await (const record of iterateJsonl(runPath)) {
    totalCases += 1;
    if (record.run.skipped) continue;
    const judgeIndices = collectJudgeIndices(record.expectations);
    for (const { index, expectation } of judgeIndices) {
      const row = await scoreOne(record, index, expectation, judge);
      appendFileSync(outPath, formatRow(row), "utf8");
      totalJudged += 1;
      if (row.passed) totalPassed += 1;
    }
  }

  const passRate = totalJudged === 0 ? "n/a" : `${((totalPassed / totalJudged) * 100).toFixed(1)}%`;
  process.stdout.write(
    `judged ${totalJudged} verdicts across ${totalCases} cases → ${outPath}\n` +
      `pass-rate: ${passRate} (${totalPassed}/${totalJudged})\n`,
  );
  return 0;
}

interface ParsedArgs {
  run: string | null;
  out: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  let run: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--run" && args[i + 1]) {
      run = resolve(args[++i] ?? "");
    } else if (flag === "--out" && args[i + 1]) {
      out = resolve(args[++i] ?? "");
    }
  }
  return { run, out };
}

function findLatestJsonl(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const reportsDir = resolve(here, "..", "reports");
  if (!existsSync(reportsDir)) return null;
  const candidates = readdirSync(reportsDir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ name: n, path: join(reportsDir, n), mtime: statSync(join(reportsDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

function defaultOutPath(runPath: string): string {
  const base = basename(runPath, ".jsonl");
  return join(dirname(runPath), `${base}.judge.csv`);
}

async function* iterateJsonl(path: string): AsyncGenerator<JsonlRecord, void, void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as JsonlRecord;
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
}

function collectJudgeIndices(
  expectations: JudgeExpectationSummary[],
): Array<{ index: number; expectation: JudgeExpectationSummary }> {
  const out: Array<{ index: number; expectation: JudgeExpectationSummary }> = [];
  for (let i = 0; i < expectations.length; i += 1) {
    const expectation = expectations[i];
    if (expectation && expectation.kind === "judge") {
      out.push({ index: i, expectation });
    }
  }
  return out;
}

async function scoreOne(
  record: JsonlRecord,
  index: number,
  expectation: JudgeExpectationSummary,
  judge: JudgeClient,
): Promise<JudgeRow> {
  const threshold = expectation.threshold ?? 4;
  const rubric = expectation.rubric ?? "(no rubric stored)";
  try {
    const verdict = await judge.score({
      prompt: record.case.prompt,
      reply: record.run.reply,
      rubric,
    });
    return {
      caseId: record.case.id,
      index,
      score: verdict.score,
      threshold,
      passed: verdict.score >= threshold,
      durationMs: verdict.durationMs,
      parseFallback: verdict.parseFallback,
      reason: verdict.reason,
    };
  } catch (err) {
    return {
      caseId: record.case.id,
      index,
      score: null,
      threshold,
      passed: false,
      durationMs: 0,
      parseFallback: false,
      reason: `judge call threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatRow(row: JudgeRow): string {
  return `${csvEscape(row.caseId)},${row.index},${
    row.score === null ? "" : row.score
  },${row.threshold},${row.passed ? "1" : "0"},${row.durationMs},${
    row.parseFallback ? "1" : "0"
  },${csvEscape(row.reason)}\n`;
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
