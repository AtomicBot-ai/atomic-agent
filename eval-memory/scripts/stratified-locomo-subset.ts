#!/usr/bin/env -S npx tsx
/**
 * Seed-deterministic stratified subset of the LoCoMo `locomo10.json`
 * corpus, written as a drop-in replacement file the runner picks up
 * via `ATOMIC_AGENT_LOCOMO_PATH=<out>`.
 *
 * Only the `qa` array per conversation is sampled — sessions are
 * preserved verbatim because halving the conversation history would
 * destroy multi-hop / temporal questions that depend on cross-session
 * evidence. Per-category proportions inside each conversation's `qa`
 * are preserved (rounded) so the category mix matches the full
 * corpus on every conversation.
 *
 * Usage:
 *
 *   npx tsx eval-memory/scripts/stratified-locomo-subset.ts \
 *     --fraction=0.5 [--seed=1] [--min-per-category=5] \
 *     [--in=eval-memory/datasets/locomo/locomo10.json] \
 *     [--out=eval-memory/datasets/locomo/locomo10-subset-...json]
 *
 * Writes both `<out>` (drop-in dataset) and `<out>.meta.json`
 * (provenance: input path, seed, fraction, per-conversation +
 * per-category before/after counts, repo HEAD SHA when available).
 *
 * `<out>` defaults to
 *   `eval-memory/datasets/locomo/locomo10-frac{F}-seed{S}.json`.
 *
 * The script is purely additive — it never overwrites the original
 * `locomo10.json`. A drop-in subset is a separate file the operator
 * can commit (or ignore via .gitignore) at their discretion.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { seededRng } from "../harness/bootstrap-ci.js";
import {
  stratifiedSample,
  summariseStrata,
} from "../harness/stratified-sample.js";
import { captureGitProvenance } from "../config/environment.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_IN = resolve(
  REPO_ROOT,
  "eval-memory",
  "datasets",
  "locomo",
  "locomo10.json",
);

interface CliArgs {
  inPath: string;
  outPath: string | null;
  fraction: number;
  seed: number;
  minPerCategory: number;
}

function log(msg: string): void {
  process.stderr.write(`[locomo-subset] ${msg}\n`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    inPath: DEFAULT_IN,
    outPath: null,
    fraction: 0.5,
    seed: 1,
    minPerCategory: 0,
  };
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "true";
    switch (key) {
      case "in":
        out.inPath = value;
        break;
      case "out":
        out.outPath = value;
        break;
      case "fraction":
        out.fraction = parseFloat(value);
        break;
      case "seed":
        out.seed = parseInt(value, 10);
        break;
      case "min-per-category":
        out.minPerCategory = Math.max(0, parseInt(value, 10));
        break;
      default:
        log(`unknown flag --${key}`);
    }
  }
  return out;
}

interface RawLocomoQa {
  question?: string;
  answer?: string;
  category?: number;
  evidence?: unknown;
  adversarial_answer?: string | null;
}

interface RawLocomoEntry {
  sample_id?: string;
  qa?: RawLocomoQa[];
  [key: string]: unknown;
}

function defaultOutPath(args: CliArgs): string {
  const inDir = dirname(args.inPath);
  const stem = basename(args.inPath, ".json");
  const fracTag = args.fraction.toFixed(2).replace(".", "p");
  return resolve(inDir, `${stem}-frac${fracTag}-seed${args.seed}.json`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.fraction) || args.fraction <= 0 || args.fraction > 1) {
    log(`--fraction must be in (0, 1] (got ${args.fraction})`);
    return 2;
  }
  const inAbs = resolve(REPO_ROOT, args.inPath);
  if (!existsSync(inAbs)) {
    log(`input dataset missing: ${inAbs}`);
    return 2;
  }
  const outAbs = resolve(REPO_ROOT, args.outPath ?? defaultOutPath(args));
  if (outAbs === inAbs) {
    log("refusing to overwrite the input dataset — choose a different --out");
    return 2;
  }

  let raw: RawLocomoEntry[];
  try {
    raw = JSON.parse(readFileSync(inAbs, "utf8")) as RawLocomoEntry[];
  } catch (err) {
    log(
      `failed to parse input dataset: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  if (!Array.isArray(raw)) {
    log("input dataset is not a JSON array");
    return 2;
  }

  const rng = seededRng(args.seed);

  const conversationsMeta: Array<{
    sampleId: string;
    qaBefore: number;
    qaAfter: number;
    perCategory: ReturnType<typeof summariseStrata>;
  }> = [];

  const sampledRaw: RawLocomoEntry[] = raw.map((entry) => {
    const qa: RawLocomoQa[] = Array.isArray(entry.qa) ? entry.qa : [];
    if (qa.length === 0) {
      conversationsMeta.push({
        sampleId: entry.sample_id ?? "(unknown)",
        qaBefore: 0,
        qaAfter: 0,
        perCategory: [],
      });
      return entry;
    }
    const sampled = stratifiedSample(
      qa,
      (q) => String(q.category ?? "?"),
      args.fraction,
      rng,
      { minPerStratum: args.minPerCategory },
    );
    const breakdown = summariseStrata(qa, sampled, (q) =>
      String(q.category ?? "?"),
    );
    conversationsMeta.push({
      sampleId: entry.sample_id ?? "(unknown)",
      qaBefore: qa.length,
      qaAfter: sampled.length,
      perCategory: breakdown,
    });
    return { ...entry, qa: sampled };
  });

  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, JSON.stringify(sampledRaw) + "\n", "utf8");

  const meta = {
    capturedAt: new Date().toISOString(),
    inputPath: inAbs,
    outputPath: outAbs,
    fraction: args.fraction,
    seed: args.seed,
    minPerCategory: args.minPerCategory,
    git: captureGitProvenance(),
    totals: {
      conversations: sampledRaw.length,
      qaBefore: conversationsMeta.reduce((s, c) => s + c.qaBefore, 0),
      qaAfter: conversationsMeta.reduce((s, c) => s + c.qaAfter, 0),
    },
    conversations: conversationsMeta,
  };
  writeFileSync(`${outAbs}.meta.json`, JSON.stringify(meta, null, 2) + "\n", "utf8");

  log(`wrote ${outAbs}`);
  log(`wrote ${outAbs}.meta.json`);
  log(
    `subset: ${meta.totals.qaAfter} / ${meta.totals.qaBefore} questions ` +
      `(${((meta.totals.qaAfter / meta.totals.qaBefore) * 100).toFixed(1)}%) ` +
      `across ${meta.totals.conversations} conversations`,
  );
  return 0;
}

process.exit(main());
