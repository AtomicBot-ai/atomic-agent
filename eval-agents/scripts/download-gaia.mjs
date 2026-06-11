#!/usr/bin/env node
/**
 * Download GAIA validation split + attachments into eval-agents/datasets/gaia/hf/.
 *
 * Requires HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) and accepting the dataset
 * license on https://huggingface.co/datasets/gaia-benchmark/GAIA
 *
 * Usage:
 *   npm run eval:agents:datasets
 *   node eval-agents/scripts/download-gaia.mjs --force
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parquetReadObjects, asyncBufferFromFile } from "hyparquet";

import { loadEnv, makeLog, REPO_ROOT } from "./_lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEST = resolve(HERE, "..", "datasets", "gaia", "hf");
const VALIDATION_DIR = join(DEST, "2023", "validation");
const META = join(VALIDATION_DIR, "metadata.jsonl");
const META_PARQUET = join(VALIDATION_DIR, "metadata.parquet");

const log = makeLog("download-gaia");

function parseArgs(argv) {
  return { force: argv.includes("--force") };
}

/**
 * Resolve a HF token from env, or fall back to the credential cached by
 * `huggingface-cli login` (~/.cache/huggingface/token). Returns null when
 * neither is available.
 */
function resolveHfToken() {
  const fromEnv = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_HUB_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const cached = join(homedir(), ".cache", "huggingface", "token");
  if (existsSync(cached)) {
    const value = readFileSync(cached, "utf8").trim();
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Resolve the HF CLI binary, preferring the modern `hf` over the
 * deprecated `huggingface-cli`. Uses a login shell so pyenv / conda
 * shims that are not on the non-interactive PATH still resolve.
 */
function resolveHfCli() {
  for (const bin of ["hf", "huggingface-cli"]) {
    const r = spawnSync("sh", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
    const out = (r.stdout ?? "").trim();
    if (r.status === 0 && out.length > 0) return out.split(/\r?\n/)[0];
  }
  return null;
}

/**
 * The current GAIA HF repo ships metadata as Parquet (metadata.parquet +
 * per-level shards), not the legacy metadata.jsonl. Convert the full
 * Parquet into the metadata.jsonl shape the harness loader expects.
 */
async function convertParquetToJsonl() {
  if (!existsSync(META_PARQUET)) {
    log(`metadata.parquet missing at ${META_PARQUET} — cannot build metadata.jsonl`);
    process.exit(2);
  }
  const file = await asyncBufferFromFile(META_PARQUET);
  const rows = await parquetReadObjects({ file });
  const lines = rows.map((r) =>
    JSON.stringify({
      task_id: r.task_id,
      Question: r.Question,
      Level: Number(r.Level),
      "Final answer": r["Final answer"] ?? "",
      file_name: r.file_name ?? "",
      file_path: r.file_path ?? "",
    }),
  );
  writeFileSync(META, `${lines.join("\n")}\n`, "utf8");
  const byLevel = {};
  for (const r of rows) byLevel[Number(r.Level)] = (byLevel[Number(r.Level)] ?? 0) + 1;
  log(`wrote ${rows.length} rows → ${META} (by level: ${JSON.stringify(byLevel)})`);
}

async function main() {
  loadEnv();
  const { force } = parseArgs(process.argv.slice(2));
  const token = resolveHfToken();
  if (!token) {
    log(
      "no HF credential found — set HF_TOKEN or run `huggingface-cli login` (gated GAIA download)",
    );
    process.exit(2);
  }

  if (!force && existsSync(META)) {
    const mb = (statSync(META).size / 1024 / 1024).toFixed(2);
    log(`already present: ${META} (${mb} MB) — use --force to re-download`);
    return;
  }

  const hfBin = resolveHfCli();
  if (!hfBin) {
    log("hf / huggingface-cli not found — install: pip install -U huggingface_hub");
    process.exit(2);
  }
  log(`using HF CLI: ${hfBin}`);

  log(`downloading gaia-benchmark/GAIA validation split → ${DEST}`);
  const r = spawnSync(
    hfBin,
    [
      "download",
      "gaia-benchmark/GAIA",
      "--repo-type",
      "dataset",
      "--include",
      "2023/validation/*",
      "--local-dir",
      DEST,
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, HF_TOKEN: token, HUGGINGFACE_HUB_TOKEN: token },
    },
  );
  if (r.status !== 0) {
    log("download failed — accept the license on HF and retry");
    process.exit(r.status ?? 1);
  }

  await convertParquetToJsonl();
  log("done.");
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
