#!/usr/bin/env node
// Memory eval — full campaign driver.
//
// Runs the experiments in cost order: E7 → E1 → E3 → E5 → E2 → E4
// (deterministic + cheapest LLM signal first, see PLAN.md § "Run
// order and gates").
//
// Failure semantics:
//   E7 fail  → STOP (Phase 6/7a lifecycle regression — pure
//             architectural check; if this fails nothing downstream
//             is trustworthy).
//   E1 fail  → STOP (recall regression — diagnose before adding noise).
//   E3 fail  → continue but mark in summary (reflection is upstream of
//             E2 / E4 / E5; a failure here predicts noise downstream
//             but the runs themselves are still informative).
//   E5 fail  → continue. Vote curation is an emergent signal that
//             drives long-horizon behaviour; one tick's miscalls do
//             not invalidate E2/E4.
//   E2 fail  → continue. The product-fitness signal is what we care
//             about, but E4 is independent.
//   E4 fail  → terminal; surface the worst exit code at the end.
//
// Forwarded CLI args are passed verbatim to each sub-script so e.g.
// `--reporter=verbose` works campaign-wide.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const log = (msg) => console.error(`[eval-memory:all] ${msg}`);

function spawnNode(scriptRel, forwarded) {
  const script = resolve(REPO_ROOT, scriptRel);
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [script, ...forwarded], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

async function main() {
  const forwarded = process.argv.slice(2);
  const skip = new Set();
  // Allow `--skip e2,e4` style for partial runs.
  for (let i = 0; i < forwarded.length; i += 1) {
    if (forwarded[i] === "--skip" && forwarded[i + 1]) {
      for (const id of forwarded[i + 1].split(",")) skip.add(id.toLowerCase().trim());
      forwarded.splice(i, 2);
      i -= 1;
    }
  }

  const results = {};
  let worst = 0;

  if (!skip.has("e7")) {
    log("=== E7 — lesson lifecycle bench (deterministic, no LLM) ===");
    const code = await spawnNode("eval-memory/scripts/run-e7.mjs", forwarded);
    results.e7 = code;
    if (code !== 0) {
      log(`E7 exited ${code} — STOP. Lifecycle / vote sweep regressed (see PLAN.md gates).`);
      return code;
    }
  } else {
    log("E7 skipped via --skip e7");
  }

  if (!skip.has("e1")) {
    log("=== E1 — recall precision (offline + optional hybrid) ===");
    const code = await spawnNode("eval-memory/scripts/run-e1.mjs", forwarded);
    results.e1 = code;
    if (code !== 0) {
      log(`E1 exited ${code} — STOP. Fix recall before proceeding (see PLAN.md gates).`);
      return code;
    }
  } else {
    log("E1 skipped via --skip e1");
  }

  if (!skip.has("e3")) {
    log("");
    log("=== E3 — reflection signal-to-noise audit ===");
    const code = await spawnNode("eval-memory/scripts/run-e3.mjs", forwarded);
    results.e3 = code;
    if (code !== 0) {
      log(`E3 exited ${code} — continuing to E2/E4 but expect downstream noise (see PLAN.md).`);
      worst = Math.max(worst, code);
    }
  } else {
    log("E3 skipped via --skip e3");
  }

  if (!skip.has("e5")) {
    log("");
    log("=== E5 — vote decision audit ===");
    const code = await spawnNode("eval-memory/scripts/run-e5.mjs", forwarded);
    results.e5 = code;
    if (code !== 0) {
      log(`E5 exited ${code} — vote calibration is off but the rest of the campaign is still informative.`);
      worst = Math.max(worst, code);
    }
  } else {
    log("E5 skipped via --skip e5");
  }

  if (!skip.has("e2")) {
    log("");
    log("=== E2 — paired multi-turn sessions ===");
    const code = await spawnNode("eval-memory/scripts/run-e2.mjs", forwarded);
    results.e2 = code;
    if (code !== 0) {
      log(`E2 exited ${code} — continuing to E4 since the consolidator path is independent.`);
      worst = Math.max(worst, code);
    }
  } else {
    log("E2 skipped via --skip e2");
  }

  if (!skip.has("e4")) {
    log("");
    log("=== E4 — distillation quality audit ===");
    const code = await spawnNode("eval-memory/scripts/run-e4.mjs", forwarded);
    results.e4 = code;
    if (code !== 0) worst = Math.max(worst, code);
  } else {
    log("E4 skipped via --skip e4");
  }

  log("");
  log(`=== campaign summary ===`);
  for (const id of ["e7", "e1", "e3", "e5", "e2", "e4"]) {
    if (results[id] === undefined) continue;
    log(`  ${id.toUpperCase()}: exit ${results[id]}`);
  }
  return worst;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(2);
  });
