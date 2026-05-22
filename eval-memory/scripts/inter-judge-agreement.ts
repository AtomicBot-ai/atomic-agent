#!/usr/bin/env -S npx tsx
/**
 * Inter-judge agreement check for a LoCoMo report directory.
 *
 * Loads `judge.ndjson` from a base run, seed-shuffles a `--sample`
 * subset, asks a second judge model (`--alt-model`) to re-score the
 * same prompts under the same rubric, and reports:
 *
 *   - exact agreement %
 *   - within-1 agreement %
 *   - Cohen's κ (unweighted + quadratic-weighted)
 *
 * Writes `inter-judge.csv` (per-item) + `inter-judge.md` (rollup) into
 * the chosen output directory (default = `<base-run>/inter-judge/`).
 *
 * Usage:
 *
 *   npx tsx eval-memory/scripts/inter-judge-agreement.ts \
 *     --base-run=eval-memory/reports/run-2026-...-locomo \
 *     --alt-model=anthropic/claude-3.5-haiku \
 *     [--sample=50] [--seed=1] [--concurrency=3] [--out=<dir>]
 *
 * The primary judge model is taken from the env (the same
 * `ATOMIC_AGENT_JUDGE_MODEL` the base run used). The alt model
 * temporarily overrides it for the second pass; the env is not
 * mutated, only the per-call config.
 *
 * Never modifies the base run directory unless `--out` points inside
 * it (default does). Failures on individual judge calls fold into the
 * report as `availableB=false` without crashing the whole check.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createJudgeClient,
  loadJudgeConfigFromEnv,
} from "../../eval/harness/judge-client.js";
import type { JudgeClient, JudgeConfig } from "../../eval/harness/judge-types.js";
import { loadMemoryEvalEnvFile } from "../harness/load-env.js";
import { pLimit } from "../harness/p-limit.js";
import { seededRng } from "../harness/bootstrap-ci.js";
import { buildInterJudgeReport } from "../harness/inter-judge-stats.js";
import {
  buildLocomoJudgePrompt,
  buildLocomoRubric,
} from "../experiments/locomo/locomo-rubric.js";
import { scoreWithRetry } from "../harness/judge.js";
import type { LocomoQuestion } from "../experiments/locomo/dataset.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

interface CliArgs {
  baseRun: string | null;
  altModel: string | null;
  sample: number;
  seed: number;
  concurrency: number;
  outDir: string | null;
}

function log(msg: string): void {
  process.stderr.write(`[inter-judge] ${msg}\n`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    baseRun: null,
    altModel: null,
    sample: 50,
    seed: 1,
    concurrency: 3,
    outDir: null,
  };
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "true";
    switch (key) {
      case "base-run":
        out.baseRun = value;
        break;
      case "alt-model":
        out.altModel = value;
        break;
      case "sample":
        out.sample = Math.max(1, parseInt(value, 10));
        break;
      case "seed":
        out.seed = parseInt(value, 10);
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

interface BaseVerdictRow {
  conversationId: string;
  profile: string;
  category: string;
  question: string;
  goldAnswer: string;
  reply: string;
  score: number;
  reason: string;
  available: boolean;
}

function loadJudgeNdjson(path: string): BaseVerdictRow[] {
  const text = readFileSync(path, "utf8");
  const out: BaseVerdictRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (typeof r.score !== "number" || typeof r.reply !== "string") continue;
    out.push({
      conversationId: String(r.conversationId ?? ""),
      profile: String(r.profile ?? ""),
      category: String(r.category ?? "single_hop"),
      question: String(r.question ?? ""),
      goldAnswer: String(r.goldAnswer ?? ""),
      reply: String(r.reply ?? ""),
      score: Number(r.score),
      reason: String(r.reason ?? ""),
      available: Boolean(r.available),
    });
  }
  return out;
}

/**
 * Map LoCoMo category label back to a numeric `category` field on
 * `LocomoQuestion`. The rubric builder cares about the label, the
 * type slot is satisfied with `1` for all but adversarial (which we
 * detect by label).
 */
function synthesiseQuestion(row: BaseVerdictRow): LocomoQuestion {
  return {
    question: row.question,
    answer: row.goldAnswer,
    category: row.category === "adversarial" ? (5 as const) : (1 as const),
    categoryLabel: row.category as LocomoQuestion["categoryLabel"],
    evidence: [],
    adversarialAnswer: null,
  };
}

function seedShuffle<T>(xs: readonly T[], seed: number): T[] {
  const arr = [...xs];
  const rng = seededRng(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function buildAltJudgeClient(altModel: string): {
  client: JudgeClient;
  config: JudgeConfig;
} {
  const baseConfig = loadJudgeConfigFromEnv();
  if (!baseConfig) {
    throw new Error(
      "no judge config in env (set OPENROUTER_API_KEY + ATOMIC_AGENT_JUDGE_MODEL)",
    );
  }
  const altConfig: JudgeConfig = { ...baseConfig, model: altModel };
  return { client: createJudgeClient(altConfig), config: altConfig };
}

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(digits);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

interface PerItemRow {
  conversationId: string;
  profile: string;
  category: string;
  question: string;
  goldAnswer: string;
  scoreA: number;
  scoreB: number;
  agreeExact: boolean;
  agreeWithinOne: boolean;
  availableB: boolean;
  reasonB: string;
}

async function main(): Promise<number> {
  loadMemoryEvalEnvFile();
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseRun) {
    log("--base-run=<dir> is required");
    return 2;
  }
  if (!args.altModel) {
    log("--alt-model=<slug> is required (e.g. openai/gpt-5.5 or anthropic/claude-3.5-haiku)");
    return 2;
  }

  const baseRunAbs = resolve(REPO_ROOT, args.baseRun);
  const judgePath = resolve(baseRunAbs, "judge.ndjson");
  if (!existsSync(judgePath)) {
    log(`missing judge.ndjson at ${judgePath} — was the base run graded?`);
    return 2;
  }
  const baseVerdicts = loadJudgeNdjson(judgePath);
  if (baseVerdicts.length === 0) {
    log(`empty judge.ndjson at ${judgePath}`);
    return 2;
  }

  const candidates = baseVerdicts.filter(
    (v) => v.available && v.reply.trim().length > 0,
  );
  if (candidates.length === 0) {
    log("no graded verdicts with non-empty replies — nothing to re-judge");
    return 2;
  }

  const shuffled = seedShuffle(candidates, args.seed);
  const subset = shuffled.slice(0, Math.min(args.sample, shuffled.length));
  log(
    `re-judging ${subset.length} of ${baseVerdicts.length} verdicts ` +
      `with alt-model=${args.altModel} seed=${args.seed} concurrency=${args.concurrency}`,
  );

  const primaryConfig = loadJudgeConfigFromEnv();
  const primaryModel = primaryConfig?.model ?? "unknown";
  const { client: altClient } = buildAltJudgeClient(args.altModel);

  const limit = pLimit(args.concurrency);
  const items: PerItemRow[] = await Promise.all(
    subset.map((row) =>
      limit(async (): Promise<PerItemRow> => {
        const q = synthesiseQuestion(row);
        const prompt = buildLocomoJudgePrompt(q);
        const rubric = buildLocomoRubric(q);
        try {
          const verdict = await scoreWithRetry(
            altClient,
            { prompt, reply: row.reply, rubric },
            { retries: 1, backoffMs: 500 },
          );
          return {
            conversationId: row.conversationId,
            profile: row.profile,
            category: row.category,
            question: row.question,
            goldAnswer: row.goldAnswer,
            scoreA: row.score,
            scoreB: verdict.score,
            agreeExact: row.score === verdict.score,
            agreeWithinOne: Math.abs(row.score - verdict.score) <= 1,
            availableB: !verdict.parseFallback,
            reasonB: verdict.reason,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            conversationId: row.conversationId,
            profile: row.profile,
            category: row.category,
            question: row.question,
            goldAnswer: row.goldAnswer,
            scoreA: row.score,
            scoreB: row.score, // neutral — won't affect agreement direction
            agreeExact: false,
            agreeWithinOne: false,
            availableB: false,
            reasonB: `alt-judge unavailable: ${msg.slice(0, 180)}`,
          };
        }
      }),
    ),
  );

  // Restrict the agreement metrics to items where the alt-judge was
  // actually available — otherwise we'd be reporting agreement on a
  // synthetic neutral pair, which is misleading.
  const usable = items.filter((it) => it.availableB);
  const scoresA = usable.map((it) => it.scoreA);
  const scoresB = usable.map((it) => it.scoreB);
  const report = buildInterJudgeReport(scoresA, scoresB, 5);

  const outDir = args.outDir
    ? resolve(REPO_ROOT, args.outDir)
    : resolve(baseRunAbs, "inter-judge");
  mkdirSync(outDir, { recursive: true });

  // ---- inter-judge.csv (per-item) ----
  const csvHeader = [
    "conversationId",
    "profile",
    "category",
    "question",
    "goldAnswer",
    "scoreA",
    "scoreB",
    "agreeExact",
    "agreeWithinOne",
    "availableB",
    "reasonB",
  ];
  const csvLines = [csvHeader.join(",")];
  for (const it of items) {
    csvLines.push(csvHeader.map((k) => csvCell((it as never)[k])).join(","));
  }
  writeFileSync(resolve(outDir, "inter-judge.csv"), `${csvLines.join("\n")}\n`, "utf8");

  // ---- inter-judge.md (rollup) ----
  const md: string[] = [];
  md.push("# Inter-judge agreement", "");
  md.push(`- Base run: ${basename(baseRunAbs)}`);
  md.push(`- Primary judge: \`${primaryModel}\``);
  md.push(`- Alt judge: \`${args.altModel}\``);
  md.push(`- Sample: ${items.length} (of ${candidates.length} candidates, seed=${args.seed})`);
  md.push(`- Alt-judge available: ${usable.length} / ${items.length}`);
  md.push("");
  md.push("## Agreement metrics (5-level ordinal scale, 1..5)");
  md.push("");
  md.push("| metric | value | interpretation |");
  md.push("|---|---|---|");
  md.push(`| n (usable) | ${report.n} | items where the alt-judge succeeded |`);
  md.push(`| exact agreement | ${fmt(report.exactAgreement)} | both judges chose the same score |`);
  md.push(`| within-1 agreement | ${fmt(report.withinOneAgreement)} | scores differ by ≤ 1 |`);
  md.push(
    `| Cohen's κ (unweighted) | ${fmt(report.cohenKappaUnweighted)} | Landis-Koch: <0.4 poor; 0.4-0.6 moderate; 0.6-0.8 substantial; >0.8 almost perfect |`,
  );
  md.push(
    `| Cohen's κ (quadratic) | ${fmt(report.cohenKappaQuadratic)} | weights near-off lighter than far-off; Kaggle-AES convention |`,
  );
  md.push("");
  md.push("Per-item rows live in `inter-judge.csv` alongside this file.");
  md.push("");
  md.push("**Reading guide.** κ ≥ 0.6 (or quadratic κ ≥ 0.7) means the rubric is reliable —");
  md.push("the campaign scores can be claimed without judge-overfit concerns. Lower values");
  md.push("mean the headline numbers depend on the choice of judge model and should be");
  md.push("reported with the judge slug + this report as an appendix.");
  writeFileSync(resolve(outDir, "inter-judge.md"), `${md.join("\n")}\n`, "utf8");

  log(`wrote ${resolve(outDir, "inter-judge.csv")}`);
  log(`wrote ${resolve(outDir, "inter-judge.md")}`);
  log(
    `agreement: exact=${fmt(report.exactAgreement)} within1=${fmt(report.withinOneAgreement)} ` +
      `κ=${fmt(report.cohenKappaUnweighted)} κ_quad=${fmt(report.cohenKappaQuadratic)}`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[inter-judge] fatal: ${msg}\n`);
    process.exit(2);
  });
