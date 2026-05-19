/**
 * Debug runner for E2E-3 — preserves state for postmortem.
 *
 * Usage:
 *   STATE_DIR=/tmp/e2e3-keep node --import tsx eval-memory/scripts/_debug-e2e3.ts
 */
import { runE2E3 } from "../experiments/e2e-3-procedure-follow/runner.js";

const stateDir = process.env.STATE_DIR ?? "/tmp/e2e3-keep/state";
const r = await runE2E3({
  llamaUrl: process.env.LLAMA_URL ?? "http://127.0.0.1:19091",
  stateDir,
});
console.log("=== REPORT ===");
console.log(JSON.stringify(r, null, 2));
console.log(`\n=== state preserved at ${stateDir} ===`);
