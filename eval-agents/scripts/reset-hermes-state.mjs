#!/usr/bin/env node
// Reset the installed Hermes Agent's persistent state so a "fully stock" eval
// run (ATOMIC_AGENT_HERMES_STATELESS=0) starts from a blank slate instead of
// inheriting memory written by a previous GAIA case.
//
// What it clears (state only — NEVER config / skills / credentials / binary):
//   - Built-in memory: memories/MEMORY.md (agent notes) + memories/USER.md
//     (user profile) via the official `hermes memory reset --yes --target all`.
//   - Optional (--sessions): per-session request dumps under ~/.hermes/sessions/.
//
// What it intentionally preserves: config.yaml, .env, SOUL.md, installed skills,
// the hermes-agent install, and auth — none of which are cross-case contamination.
//
// Usage:
//   node eval-agents/scripts/reset-hermes-state.mjs            # memory only
//   node eval-agents/scripts/reset-hermes-state.mjs --sessions # + session dumps
//
// HERMES_CLI resolution mirrors the adapter: explicit absolute path from
// eval-agents/.env (HERMES_CLI=...) wins; otherwise falls back to `hermes` on PATH.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadEnv, makeLog } from "./_lib.mjs";

const log = makeLog("reset-hermes");

const DEFAULT_CLI = "hermes";

function resolveHermesCli() {
  const cli = process.env.HERMES_CLI ?? DEFAULT_CLI;
  // Absolute path: use as-is when it exists on disk.
  if (cli.includes("/")) {
    return existsSync(cli) ? cli : null;
  }
  // Bare name: probe PATH via `command -v`.
  const probe = spawnSync("sh", ["-c", `command -v ${cli}`], { encoding: "utf8" });
  const found = (probe.stdout ?? "").trim();
  return found || null;
}

function resetBuiltinMemory(bin) {
  log("hermes memory reset --yes --target all");
  const r = spawnSync(bin, ["memory", "reset", "--yes", "--target", "all"], {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`hermes memory reset exited ${r.status}`);
  }
}

function clearSessionDumps() {
  const dir = join(homedir(), ".hermes", "sessions");
  if (!existsSync(dir)) {
    log("no ~/.hermes/sessions/ — nothing to clear");
    return 0;
  }
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) {
        rmSync(full);
        removed += 1;
      }
    } catch (err) {
      log(`skip ${entry}: ${err?.message ?? err}`);
    }
  }
  log(`cleared ${removed} session dump(s) from ~/.hermes/sessions/`);
  return removed;
}

function main() {
  loadEnv();

  const bin = resolveHermesCli();
  if (!bin) {
    log(
      `hermes CLI not found (set HERMES_CLI=$HOME/.hermes/hermes-agent/hermes in eval-agents/.env)`,
    );
    return 2;
  }
  log(`using hermes at ${bin}`);

  try {
    resetBuiltinMemory(bin);
  } catch (err) {
    log(`memory reset failed: ${err?.message ?? err}`);
    return 1;
  }

  if (process.argv.includes("--sessions")) {
    clearSessionDumps();
  }

  log("done — next Hermes run starts with a blank-slate memory");
  return 0;
}

process.exit(main());
