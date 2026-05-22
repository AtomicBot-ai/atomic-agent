#!/usr/bin/env node
/**
 * Phase 0 environment-lock CLI for the memory benchmark campaign.
 *
 * Usage:
 *
 *   node --import tsx eval-memory/scripts/lock-environment.ts \
 *        [--out <path>] [--diff <baseline.json>]
 *
 * Brings up the managed llama daemon (or honours
 * `ATOMIC_AGENT_EVAL_LLAMA_URL`), probes `/props` for chat + embedding
 * models, captures sampling knobs + agent version + judge config, and
 * writes a JSON snapshot to `eval-memory/reports/environment-lock.json`
 * by default.
 *
 * When `--diff <baseline.json>` is provided, the script compares the
 * fresh snapshot against the file and exits non-zero on any mismatch
 * (modulo `capturedAt`). This is the reproducibility stop-gate from
 * PLAN.md Phase 0 — every subsequent campaign run reads the locked
 * snapshot before doing anything and aborts on drift.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMemoryEvalEnvFile } from "../harness/load-env.js";
import {
  bringUpLlama,
  probeEmbeddingDaemon,
} from "../harness/llama-lifecycle.js";
import {
  captureEnvironmentSnapshot,
  diffSnapshots,
} from "../config/environment.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT = resolve(
  REPO_ROOT,
  "eval-memory",
  "reports",
  "environment-lock.json",
);

interface ParsedArgs {
  out: string;
  diff: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { out: DEFAULT_OUT, diff: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") {
      out.out = argv[++i] ?? out.out;
    } else if (a === "--diff") {
      out.diff = argv[++i] ?? null;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node --import tsx eval-memory/scripts/lock-environment.ts " +
          "[--out <path>] [--diff <baseline>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`[lock-environment] unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<number> {
  loadMemoryEvalEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const llama = await bringUpLlama();
  let snapshot;
  try {
    const embeddingUrl = await probeEmbeddingDaemon();
    snapshot = await captureEnvironmentSnapshot({
      chatUrl: llama.url,
      embeddingUrl,
    });
  } finally {
    llama.shutdown();
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  process.stderr.write(`[lock-environment] wrote ${args.out}\n`);

  if (args.diff) {
    if (!existsSync(args.diff)) {
      process.stderr.write(
        `[lock-environment] --diff: baseline missing at ${args.diff}\n`,
      );
      return 2;
    }
    const baseline = JSON.parse(readFileSync(args.diff, "utf8"));
    const diffs = diffSnapshots(baseline, snapshot);
    if (diffs.length === 0) {
      process.stderr.write(
        `[lock-environment] --diff: snapshot matches baseline\n`,
      );
      return 0;
    }
    process.stderr.write(
      `[lock-environment] --diff: ${diffs.length} drift(s) detected:\n`,
    );
    for (const d of diffs) {
      process.stderr.write(
        `  ${d.path}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}\n`,
      );
    }
    return 1;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[lock-environment] fatal: ${msg}\n`);
    process.exit(2);
  });
