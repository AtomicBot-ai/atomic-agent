#!/usr/bin/env -S npx tsx
/**
 * Re-grade a LoCoMo `questions.ndjson` with the configured LLM judge
 * (`ATOMIC_AGENT_JUDGE_MODEL`, default `openai/gpt-5.4-mini` via
 * OpenRouter). Standalone — does NOT touch the agent / llama-server.
 *
 * Use when:
 *  - the original `npm run eval:memory:locomo` timed out before the
 *    judge post-pass (partial questions.ndjson on disk);
 *  - you want to re-grade an existing run with a different judge
 *    model for an inter-judge cross-check;
 *  - you want to add judge scores to runs that were originally
 *    scored without a judge (`ATOMIC_AGENT_LOCOMO_JUDGE_DISABLED=1`).
 *
 * Usage:
 *   npx tsx eval-memory/scripts/locomo-rejudge.ts \
 *     --run=eval-memory/reports/run-...-locomo \
 *     [--live-only]                   skip questions with empty replies
 *     [--concurrency=3]
 *     [--out=<dir>]                   default = <run>/
 *
 * Output (alongside the source ndjson):
 *   - judge.ndjson           one verdict per question (overwrites if present)
 *   - by-category-judge.csv  rollup per (profile, category)
 *   - summary-judge.md       human-readable rollup, separate from the
 *                            run's main summary.md so the original
 *                            run record stays untouched.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMemoryEvalEnvFile } from "../harness/load-env.js";
import { resolveJudge } from "../harness/judge.js";
import {
  judgeLocomoResults,
  summariseJudgeByCategory,
  type LocomoJudgeVerdict,
} from "../experiments/locomo/locomo-judge.js";
import type {
  LocomoCategoryLabel,
  LocomoQuestion,
} from "../experiments/locomo/dataset.js";
import { appendJsonl } from "../harness/reports.js";
import type { CampaignProfileName } from "../config/campaign-profiles.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

interface CliArgs {
  runDir: string | null;
  liveOnly: boolean;
  concurrency: number;
  outDir: string | null;
}

function log(msg: string): void {
  process.stderr.write(`[locomo-rejudge] ${msg}\n`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    runDir: null,
    liveOnly: false,
    concurrency: 3,
    outDir: null,
  };
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "true";
    switch (key) {
      case "run":
        out.runDir = value;
        break;
      case "live-only":
        out.liveOnly = value !== "false";
        break;
      case "concurrency":
        out.concurrency = Math.max(1, parseInt(value, 10));
        break;
      case "out":
        out.outDir = value;
        break;
      default:
        log(`unknown flag --${key}`);
    }
  }
  return out;
}

interface QuestionRow {
  conversationId: string;
  profile: CampaignProfileName;
  category: LocomoCategoryLabel;
  question: string;
  goldAnswer: string;
  adversarial: boolean;
  assistantReply: string;
}

function loadQuestionsNdjson(path: string): QuestionRow[] {
  const text = readFileSync(path, "utf8");
  const out: QuestionRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const r = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof r.assistantReply !== "string") continue;
      out.push({
        conversationId: String(r.conversationId ?? ""),
        profile: String(r.profile ?? "") as CampaignProfileName,
        category: String(r.category ?? "single_hop") as LocomoCategoryLabel,
        question: String(r.question ?? ""),
        goldAnswer: String(r.goldAnswer ?? ""),
        adversarial: Boolean(r.adversarial),
        assistantReply: String(r.assistantReply ?? ""),
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const LABEL_TO_ID: Record<LocomoCategoryLabel, 1 | 2 | 3 | 4 | 5> = {
  single_hop: 1,
  multi_hop: 2,
  temporal: 3,
  open_domain: 4,
  adversarial: 5,
};

function synthesise(row: QuestionRow): LocomoQuestion {
  return {
    question: row.question,
    answer: row.goldAnswer,
    category: LABEL_TO_ID[row.category] ?? 1,
    categoryLabel: row.category,
    evidence: [],
    adversarialAnswer: row.adversarial ? row.goldAnswer : null,
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const raw = String(v);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsv(
  path: string,
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): void {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

async function main(): Promise<number> {
  loadMemoryEvalEnvFile();
  const args = parseArgs(process.argv.slice(2));
  if (!args.runDir) {
    log("--run=<dir> is required");
    return 2;
  }
  const runAbs = resolve(REPO_ROOT, args.runDir);
  const ndjsonPath = resolve(runAbs, "questions.ndjson");
  if (!existsSync(ndjsonPath)) {
    log(`missing ${ndjsonPath}`);
    return 2;
  }

  const all = loadQuestionsNdjson(ndjsonPath);
  if (all.length === 0) {
    log("questions.ndjson is empty");
    return 2;
  }
  const rows = args.liveOnly
    ? all.filter((r) => r.assistantReply.trim().length > 0)
    : all;
  log(
    `loaded ${all.length} questions (live-only=${args.liveOnly} → ${rows.length} to grade)`,
  );

  const resolved = resolveJudge();
  if (!resolved) {
    log("no judge configured (set OPENROUTER_API_KEY + ATOMIC_AGENT_JUDGE_MODEL)");
    return 2;
  }
  log(`judge: ${resolved.config.model} (concurrency=${args.concurrency})`);

  const inputs = rows.map((r) => ({
    profile: r.profile,
    conversationId: r.conversationId,
    question: synthesise(r),
    reply: r.assistantReply,
  }));

  const t0 = Date.now();
  const verdicts: LocomoJudgeVerdict[] = await judgeLocomoResults({
    judge: resolved.client,
    inputs,
    concurrency: args.concurrency,
  });
  const elapsedMs = Date.now() - t0;
  log(`graded ${verdicts.length} verdicts in ${(elapsedMs / 1000).toFixed(1)}s`);

  const outDir = args.outDir ? resolve(REPO_ROOT, args.outDir) : runAbs;
  mkdirSync(outDir, { recursive: true });

  const judgePath = resolve(outDir, "judge.ndjson");
  // Overwrite (do not append) — caller asked for a re-grade.
  writeFileSync(judgePath, "", "utf8");
  for (const v of verdicts) appendJsonl(judgePath, v);

  const summary = summariseJudgeByCategory(verdicts);
  writeCsv(
    resolve(outDir, "by-category-judge.csv"),
    [
      "profile",
      "category",
      "graded",
      "judgeAvailable",
      "meanJudgeScore",
      "judgeAccAtFour",
      "judgeAccAtFive",
    ],
    summary as unknown as readonly Record<string, unknown>[],
  );

  // Compact markdown rollup (separate file so we never clobber the
  // run's main summary.md).
  const md: string[] = [];
  md.push("# LoCoMo re-judge rollup", "");
  md.push(`- Source run: ${basename(runAbs)}`);
  md.push(`- Judge: \`${resolved.config.model}\``);
  md.push(`- Graded: ${verdicts.length} / ${all.length} questions ${args.liveOnly ? "(live-only)" : ""}`);
  md.push(`- Wall-clock: ${(elapsedMs / 1000).toFixed(1)}s`);
  const avail = verdicts.filter((v) => v.available).length;
  md.push(`- Judge available: ${avail} / ${verdicts.length}`);
  md.push("");
  md.push("## Judge score by profile × category (1..5 scale)");
  md.push("");
  md.push("| profile | category | n | mean | ≥4 | =5 | available |");
  md.push("|---|---|---|---|---|---|---|");
  for (const r of summary) {
    md.push(
      `| ${r.profile} | ${r.category} | ${r.graded} | ${r.meanJudgeScore.toFixed(2)} | ` +
        `${r.judgeAccAtFour.toFixed(2)} | ${r.judgeAccAtFive.toFixed(2)} | ${r.judgeAvailable}/${r.graded} |`,
    );
  }
  // Overall row
  if (verdicts.length > 0) {
    const overallMean =
      verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length;
    const overallGEQ4 =
      verdicts.filter((v) => v.score >= 4).length / verdicts.length;
    const overallEQ5 =
      verdicts.filter((v) => v.score >= 5).length / verdicts.length;
    md.push("|  |  |  |  |  |  |  |");
    md.push(
      `| **OVERALL** | * | ${verdicts.length} | **${overallMean.toFixed(2)}** | ${overallGEQ4.toFixed(2)} | ${overallEQ5.toFixed(2)} | ${avail}/${verdicts.length} |`,
    );
  }
  writeFileSync(resolve(outDir, "summary-judge.md"), md.join("\n") + "\n", "utf8");

  log(`wrote ${judgePath}`);
  log(`wrote ${resolve(outDir, "by-category-judge.csv")}`);
  log(`wrote ${resolve(outDir, "summary-judge.md")}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[locomo-rejudge] fatal: ${msg}\n`);
    process.exit(2);
  });
