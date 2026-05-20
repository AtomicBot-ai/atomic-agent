#!/usr/bin/env node
// Multi-run LoCoMo orchestrator. Spawns `run-locomo.mjs` N times in
// series (the chat llama-server is a single resource, so parallel
// runs would just contend), then invokes `aggregate-locomo-runs.ts`
// via `tsx` to roll the N per-run report dirs into one aggregate
// with bootstrap 95% confidence intervals.
//
// Knobs (CLI flag wins over env):
//
//   --runs=N   / ATOMIC_AGENT_LOCOMO_MULTI_RUNS    number of runs (default 3)
//   --label=S  / ATOMIC_AGENT_LOCOMO_MULTI_LABEL   aggregate dir slug (default "locomo-multi")
//
// Everything else (profiles, max-sessions, max-questions, judge knobs,
// timeouts) is forwarded unchanged via the inherited environment —
// set them once in the shell env or `eval-memory/.env`.

import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv, makeLog, REPO_ROOT } from "./_lib.mjs";

const log = makeLog("locomo-multi");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORTS_DIR = resolve(REPO_ROOT, "eval-memory", "reports");
const AGGREGATE_SCRIPT = resolve(HERE, "aggregate-locomo-runs.ts");

const args = parseArgs(process.argv.slice(2));
const RUNS = numericEnvOrFlag(
  "ATOMIC_AGENT_LOCOMO_MULTI_RUNS",
  args.runs,
  3,
);
const LABEL =
  args.label ?? process.env.ATOMIC_AGENT_LOCOMO_MULTI_LABEL ?? "locomo-multi";

async function main() {
  loadEnv();
  if (RUNS < 1) {
    log(`--runs must be >= 1 (got ${RUNS})`);
    return 2;
  }
  log(`will run \`npm run eval:memory:locomo\` ${RUNS} time(s) in series`);

  const runDirs = [];
  for (let i = 0; i < RUNS; i += 1) {
    const before = new Set(listLocomoDirs());
    log(`--- run ${i + 1}/${RUNS} starting ---`);
    const code = spawnRun();
    if (code !== 0) {
      log(
        `run ${i + 1} exited with non-zero code ${code} — continuing so partial aggregate is still produced`,
      );
    }
    const after = listLocomoDirs();
    const fresh = after.find((d) => !before.has(d));
    if (fresh) {
      runDirs.push(resolve(REPORTS_DIR, fresh));
      log(`run ${i + 1} report: ${fresh}`);
    } else {
      log(`run ${i + 1} produced no new report dir — skipping in aggregate`);
    }
  }

  if (runDirs.length === 0) {
    log("no runs produced reports — nothing to aggregate");
    return 1;
  }

  const aggregateCode = spawnAggregate(runDirs);
  return aggregateCode;
}

function spawnRun() {
  const result = spawnSync("npm", ["run", "eval:memory:locomo"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function spawnAggregate(runDirs) {
  log(`aggregating ${runDirs.length} run dir(s) via tsx`);
  const result = spawnSync(
    "npx",
    ["tsx", AGGREGATE_SCRIPT, `--label=${LABEL}`, ...runDirs],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function listLocomoDirs() {
  return readdirSync(REPORTS_DIR)
    .filter((name) => name.endsWith("-locomo"))
    .filter((name) => {
      try {
        return statSync(resolve(REPORTS_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] ?? "true";
  }
  return out;
}

function numericEnvOrFlag(envName, flagVal, fallback) {
  const raw = flagVal ?? process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(2);
  });
