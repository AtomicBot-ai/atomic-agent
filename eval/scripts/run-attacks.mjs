#!/usr/bin/env node
// Pre-release attack run (ATO-623): every case under eval/cases/attacks/
// against one local model, then a compact report in eval/reports/.
//
// It is run-full-eval.mjs with another vitest config, so model selection
// works the same way: the managed daemon by default, or
// ATOMIC_AGENT_EVAL_LLAMA_URL for a server you started yourself.
//
// Usage:
//   npm run eval:attacks
//   npm run eval:attacks -- -t <case-id>          # one case
//   ATOMIC_AGENT_EVAL_LLAMA_URL=http://127.0.0.1:8080 npm run eval:attacks
//
// Report: eval/reports/attacks-<timestamp>.md and .json, plus
// eval/reports/attacks-latest.md (scenario, verdict, model, date).
//
// With no case files yet it says so and exits 0 without touching a model.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CASES_DIR = resolve(REPO_ROOT, "eval", "cases", "attacks");

const caseFiles = existsSync(CASES_DIR)
  ? readdirSync(CASES_DIR).filter((name) => name.endsWith(".case.ts"))
  : [];

if (caseFiles.length === 0) {
  console.error(
    "[eval:attacks] no attack cases yet: add eval/cases/attacks/<id>.case.ts and list it in eval/cases/attacks/index.ts (see eval/README.md, \"Attack suite\").",
  );
  process.exit(0);
}

console.error(`[eval:attacks] ${caseFiles.length} attack case file(s) found`);
const child = spawn(
  process.execPath,
  [resolve(HERE, "run-full-eval.mjs"), ...process.argv.slice(2)],
  {
    cwd: REPO_ROOT,
    env: { ...process.env, ATOMIC_AGENT_EVAL_VITEST_CONFIG: "eval/vitest.attacks.config.ts" },
    stdio: "inherit",
  },
);
child.on("exit", (code, signal) => process.exit(signal ? 130 : code ?? 1));
