#!/usr/bin/env node
/**
 * Download the external L1 benchmark datasets (LoCoMo + LongMemEval)
 * into `eval-memory/datasets/<bench>/`. The runners look for the
 * exact filenames documented in each `datasets/<bench>/README.md`;
 * this script materialises them.
 *
 * Usage:
 *
 *   node eval-memory/scripts/download-benchmark-datasets.mjs
 *     --bench all|locomo|longmemeval   (default: all)
 *     --force                          (default: false — skip when on disk)
 *     --quiet
 *
 * Network: requires reachability to raw.githubusercontent.com (LoCoMo
 * GitHub release tree) and huggingface.co (LongMemEval dataset repo).
 * No authentication needed — both repos are public.
 *
 * Licenses (cited verbatim from the upstream READMEs):
 *   - LoCoMo: research-only, see snap-research/locomo LICENSE.
 *   - LongMemEval: research-only, see xiaowu0162/LongMemEval LICENSE.
 * Datasets are not committed; the user is responsible for honouring
 * these terms. The script writes to gitignored paths only.
 */

import { mkdirSync, statSync, createWriteStream, existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DATASETS_ROOT = resolve(REPO_ROOT, "eval-memory", "datasets");

const SOURCES = {
  locomo: {
    label: "LoCoMo (snap-research)",
    files: [
      {
        // The canonical 10-conversation eval split.
        url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
        out: "locomo/locomo10.json",
      },
    ],
  },
  longmemeval: {
    label: "LongMemEval_S cleaned (xiaowu0162)",
    files: [
      {
        // The original `xiaowu0162/longmemeval` repo is deprecated by
        // the authors in favour of `longmemeval-cleaned` (noisy
        // history sessions that interfered with answer correctness
        // were removed). We save under the legacy filename
        // `longmemeval_s.json` so the runner's default path works
        // without an env override.
        url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
        out: "longmemeval/longmemeval_s.json",
      },
    ],
  },
};

function parseArgs(argv) {
  const out = { bench: "all", force: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--bench") out.bench = argv[++i] ?? "all";
    else if (a === "--force") out.force = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: download-benchmark-datasets.mjs " +
          "[--bench all|locomo|longmemeval] [--force] [--quiet]\n",
      );
      process.exit(0);
    }
  }
  return out;
}

function log(quiet, msg) {
  if (!quiet) process.stderr.write(`[download-datasets] ${msg}\n`);
}

/**
 * Stream-download `url` to `destPath`. Writes to a `.partial` sibling
 * first and `rename()`s on success so an interrupted download never
 * leaves a half-file the runner would mistakenly treat as valid.
 */
async function downloadFile({ url, destPath, quiet }) {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;
  if (existsSync(tmpPath)) await unlink(tmpPath).catch(() => undefined);

  const t0 = Date.now();
  log(quiet, `GET ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size) log(quiet, `  content-length: ${(size / 1024 / 1024).toFixed(1)} MB`);

  const out = createWriteStream(tmpPath);
  await finished(Readable.fromWeb(res.body).pipe(out));
  await rename(tmpPath, destPath);
  const st = statSync(destPath);
  log(
    quiet,
    `  → ${destPath} (${(st.size / 1024 / 1024).toFixed(1)} MB in ${
      ((Date.now() - t0) / 1000).toFixed(1)
    }s)`,
  );
}

async function downloadBench({ name, force, quiet }) {
  const src = SOURCES[name];
  if (!src) {
    throw new Error(`unknown bench '${name}' — valid: ${Object.keys(SOURCES).join(", ")}`);
  }
  log(quiet, `=== ${src.label} ===`);
  for (const file of src.files) {
    const destPath = join(DATASETS_ROOT, file.out);
    if (!force && existsSync(destPath)) {
      const sizeMb = (statSync(destPath).size / 1024 / 1024).toFixed(1);
      log(quiet, `already present: ${destPath} (${sizeMb} MB) — skipping (use --force to overwrite)`);
      continue;
    }
    await downloadFile({ url: file.url, destPath, quiet });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.bench === "all"
    ? Object.keys(SOURCES)
    : args.bench.split(",").map((s) => s.trim()).filter(Boolean);

  for (const bench of targets) {
    await downloadBench({ name: bench, force: args.force, quiet: args.quiet });
  }
  log(args.quiet, "done.");
}

main().catch((err) => {
  process.stderr.write(`[download-datasets] FATAL ${err?.stack ?? err}\n`);
  process.exit(1);
});
