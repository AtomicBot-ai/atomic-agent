#!/usr/bin/env node
// Minimal one-shot diagnostic that bypasses the full diagnose-hang.mjs
// pipeline. Hard-codes the failing-case fixtures inline so we don't have
// to load eval/cases/index.ts via tsx (which hung the previous attempt).
//
// Usage:
//   node eval/scripts/diagnose-inline.mjs greedy-regex
//   node eval/scripts/diagnose-inline.mjs no-edit-just-report
//
// Writes:
//   eval/reports/diagnose-inline-<case>.stderr.log
//   eval/reports/diagnose-inline-<case>.stdout.log
//
// Side-effects:
//   - assumes managed daemon is already up on http://127.0.0.1:19091
//   - creates a fresh temp workspace + state dir, cleans them up

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");
const REPORTS = resolve(REPO_ROOT, "eval", "reports");
const LLAMA_URL = "http://127.0.0.1:19091";

const FIXTURES = {
  "greedy-regex": {
    id: "coding-fix-greedy-regex",
    files: {
      "src/extract.ts":
        "export function extractFirstTag(html: string): string | null {\n" +
        "  const m = html.match(/<(.+)>/);\n" +
        "  return m ? m[1] : null;\n" +
        "}\n",
    },
    prompt:
      'src/extract.ts has a greedy regex. For input "<a><b>" it captures ' +
      '"a><b" instead of "a". Fix the regex so extractFirstTag returns ' +
      "only the first tag's contents. Keep the function signature.",
  },
  "no-edit-just-report": {
    id: "axis-instruction-no-edit-just-report",
    files: {
      "src/age.ts":
        "export function isAdult(age: number): boolean {\n" +
        "  // BUG: off-by-one — should be >= 18, not > 18.\n" +
        "  return age > 18;\n" +
        "}\n",
    },
    prompt:
      "Look at src/age.ts. It has a bug. EXPLAIN the bug in your reply. " +
      "DO NOT modify any file. DO NOT run any shell command. Only read.",
  },
};

const SEED_CONFIG = {
  version: 10,
  localModels: { url: LLAMA_URL },
  log: { level: "info" },
  agent: {
    tokenBudget: 3000,
    maxSteps: 25,
    toolTimeoutMs: 60_000,
    approvalRequired: false,
    conversationMaxTokens: 32_000,
    worldSnapshotMaxTokens: 8_000,
  },
  http: {
    enabled: true,
    approvalMode: "writes",
    hostAllowlist: null,
    maxResponseBytes: 1_048_576,
    defaultTimeoutMs: 30_000,
  },
  tracing: { trace: { enabled: true, maxBytesPerSession: 10 * 1024 * 1024 } },
};

const log = (m) => console.error(`[diag-inline] ${m}`);

function parseArgs(argv) {
  const id = argv[0];
  if (!id || !FIXTURES[id]) {
    console.error("Usage: node diagnose-inline.mjs <greedy-regex|no-edit-just-report>");
    process.exit(2);
  }
  const timeoutIdx = argv.indexOf("--timeout-ms");
  const timeoutMs = timeoutIdx >= 0 ? Number.parseInt(argv[timeoutIdx + 1], 10) : 180_000;
  return { id, timeoutMs };
}

async function main() {
  const { id, timeoutMs } = parseArgs(process.argv.slice(2));
  const fixture = FIXTURES[id];
  log(`case: ${fixture.id}`);
  log(`timeout: ${timeoutMs}ms`);

  // Probe daemon health upfront.
  try {
    const r = await fetch(`${LLAMA_URL}/health`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (err) {
    log(`fatal: llama-server not healthy at ${LLAMA_URL}: ${err.message}`);
    log(`hint: \`node dist/cli/index.js models start\``);
    process.exit(2);
  }
  log(`daemon healthy at ${LLAMA_URL}`);

  // Build workspace.
  const root = mkdtempSync(join(tmpdir(), `diag-inline-${id}-`));
  const workingDir = join(root, "wd");
  const stateDir = join(root, "state");
  mkdirSync(workingDir);
  mkdirSync(stateDir);
  log(`workspace: ${root}`);

  // Seed config.
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(SEED_CONFIG, null, 2), "utf8");

  // Materialise fixtures.
  for (const [rel, body] of Object.entries(fixture.files)) {
    const abs = join(workingDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  log(`prompt: ${JSON.stringify(fixture.prompt).slice(0, 160)}`);

  // Spawn CLI.
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [CLI_BIN, "run", "--cwd", workingDir, "--no-approval", "--max-steps", "15"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ATOMIC_AGENT_STATE_DIR: stateDir,
        ATOMIC_AGENT_LOG_LEVEL: "debug",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdoutAll = "";
  let stderrAll = "";
  let lastStderrLine = "";
  const tStamp = () => `+${(Date.now() - startedAt).toString().padStart(6, " ")}ms`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutAll += text;
    for (const line of text.split("\n")) {
      if (line.trim()) console.log(`${tStamp()} OUT │ ${line}`);
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrAll += text;
    for (const line of text.split("\n")) {
      if (line.trim()) {
        lastStderrLine = line;
        console.log(`${tStamp()} ERR │ ${line}`);
      }
    }
  });

  child.stdin.write(`${fixture.prompt}\n`);
  child.stdin.end();

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    log(`HARD-KILLING after ${timeoutMs}ms — last stderr line was:`);
    log(`  > ${lastStderrLine}`);
    child.kill("SIGKILL");
  }, timeoutMs);

  // Belt-and-suspenders: outer guard timer in case `close` is never emitted.
  const outerTimer = setTimeout(() => {
    log(`OUTER timeout — close event never fired, force-exiting`);
    process.exit(3);
  }, timeoutMs + 30_000);

  const exitInfo = await new Promise((r) => {
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      clearTimeout(outerTimer);
      r({ code, signal });
    });
  });

  log("─".repeat(60));
  log(`exit: code=${exitInfo.code} signal=${exitInfo.signal} dur=${Date.now() - startedAt}ms timedOut=${timedOut}`);
  log(`stdout bytes: ${stdoutAll.length}, stderr bytes: ${stderrAll.length}`);

  // Persist artefacts.
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, `diagnose-inline-${id}.stderr.log`), stderrAll, "utf8");
  writeFileSync(join(REPORTS, `diagnose-inline-${id}.stdout.log`), stdoutAll, "utf8");
  log(`saved: eval/reports/diagnose-inline-${id}.stderr.log`);
  log(`saved: eval/reports/diagnose-inline-${id}.stdout.log`);

  // Cleanup workspace.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}

  process.exit(exitInfo.code === null ? 1 : exitInfo.code);
}

main().catch((err) => {
  console.error(`[diag-inline] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
