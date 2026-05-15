#!/usr/bin/env node
// One-shot diagnostic: spawn a single eval case in isolation and stream
// the agent's stderr live with millisecond timestamps. Use this to find
// where the agent hangs when the harness reports `steps=0, prompt_tokens=0,
// duration=300s` (i.e. the agent never even reached its first inference).
//
// Usage:
//   node eval/scripts/diagnose-hang.mjs <case-id> [--timeout-ms 60000]
//
// Examples:
//   node eval/scripts/diagnose-hang.mjs judge-explain-cache-decision
//   node eval/scripts/diagnose-hang.mjs coding-rename-function-across-files --timeout-ms 90000
//
// What it does:
//   1. Resolves managed daemon URL via `atomic-agent models status`. If
//      down, starts it. Cleans up only if we started it.
//   2. Creates a fresh temp workspace + state dir (mirrors run-case.ts).
//   3. Seeds config + skills the same way the harness does.
//   4. Runs the case's `setup()` to materialise fixtures.
//   5. Spawns the CLI with stdio piped, writes prompt + EOF.
//   6. Live-prints stderr lines with `+Xms` timestamps so you can see
//      exactly when (and where) progress stalls.
//   7. Hard-kills after `--timeout-ms` (default 60s) and prints the last
//      observed stderr line.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");

const log = (msg) => console.error(`[diag] ${msg}`);

function parseArgs(argv) {
  const args = { caseId: null, timeoutMs: 60_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (!a.startsWith("--") && args.caseId === null) {
      args.caseId = a;
    }
  }
  if (!args.caseId) {
    console.error("Usage: node eval/scripts/diagnose-hang.mjs <case-id> [--timeout-ms 60000]");
    process.exit(2);
  }
  return args;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function parseStatus(stdout) {
  const port = stdout.match(/port\s+(\d+)|:(\d{4,5})/);
  const portValue = port ? Number(port[1] ?? port[2]) : null;
  const healthMatch = stdout.match(/health:\s*(\S+)/);
  return { port: portValue, health: healthMatch?.[1] ?? null };
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not become healthy at ${url} in ${timeoutMs}ms`);
}

async function ensureDaemon() {
  const overrideUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  if (overrideUrl) {
    log(`using ATOMIC_AGENT_EVAL_LLAMA_URL=${overrideUrl}`);
    return { baseUrl: overrideUrl, startedByUs: false };
  }
  const status0 = runCli(["models", "status"], { capture: true });
  if (status0.status !== 0) {
    throw new Error(`models status failed: ${status0.stderr || status0.stdout}`);
  }
  const info = parseStatus(status0.stdout);
  if (!info.port) throw new Error("could not parse managed port");
  const baseUrl = `http://127.0.0.1:${info.port}`;

  // Probe /health directly — `models status` parser sometimes misses
  // the health line shape, so trust the actual endpoint.
  let alreadyUp = false;
  try {
    const r = await fetch(`${baseUrl}/health`);
    alreadyUp = r.ok;
  } catch {}
  if (alreadyUp) {
    log(`reusing healthy daemon at ${baseUrl}`);
    return { baseUrl, startedByUs: false };
  }

  log(`daemon down, starting...`);
  const start = runCli(["models", "start"]);
  if (start.status !== 0) throw new Error(`models start failed`);
  await waitForHealth(baseUrl, 120_000);
  return { baseUrl, startedByUs: true };
}

async function loadCaseSpec(caseId) {
  const { EVAL_CASES } = await import(
    `file://${resolve(REPO_ROOT, "eval", "cases", "index.ts")}`
  );
  const spec = EVAL_CASES.find((c) => c.id === caseId);
  if (!spec) {
    const ids = EVAL_CASES.map((c) => `  - ${c.id}`).join("\n");
    throw new Error(`unknown case "${caseId}". Known cases:\n${ids}`);
  }
  return spec;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`case: ${args.caseId}`);
  log(`timeout: ${args.timeoutMs}ms`);

  // 1. Daemon up.
  const daemon = await ensureDaemon();

  // 2. Workspace.
  const workspace = mkdtempSync(join(tmpdir(), `diagnose-${args.caseId}-`));
  const workingDir = join(workspace, "wd");
  const stateDir = join(workspace, "state");
  mkdirSync(workingDir);
  mkdirSync(stateDir);
  log(`workspace: ${workspace}`);

  // 3. Seed config + skills (same as harness).
  const { seedStateDirConfig } = await import(
    `file://${resolve(REPO_ROOT, "eval", "harness", "seed-state-config.ts")}`
  );
  const { installEvalSkills } = await import(
    `file://${resolve(REPO_ROOT, "eval", "harness", "install-eval-skills.ts")}`
  );
  // seedStateDirConfig reads ATOMIC_AGENT_EVAL_LLAMA_URL from env, so
  // we set it here in case the operator did not export it. The harness
  // (eval:full) does this for us via run-full-eval.mjs; this script
  // mimics the same handshake.
  if (!process.env.ATOMIC_AGENT_EVAL_LLAMA_URL) {
    process.env.ATOMIC_AGENT_EVAL_LLAMA_URL = daemon.baseUrl;
  }
  seedStateDirConfig(stateDir);
  installEvalSkills(stateDir);

  // 4. Case setup.
  const spec = await loadCaseSpec(args.caseId);
  if (spec.setup) {
    await spec.setup({ workingDir, stateDir, mockHttpUrl: null });
  }
  log(`prompt: ${JSON.stringify(spec.prompt).slice(0, 200)}`);

  // 5. Spawn agent CLI with live stderr capture.
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [
      CLI_BIN,
      "run",
      "--cwd",
      workingDir,
      "--no-approval",
      "--max-steps",
      String(spec.maxSteps ?? 15),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ATOMIC_AGENT_STATE_DIR: stateDir,
        // crank logs if the runtime supports a level knob
        ATOMIC_AGENT_LOG_LEVEL: "debug",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let lastStderrLine = "";
  let stdoutAll = "";
  let stderrAll = "";

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

  // Write prompt + EOF immediately, mirroring spawn-agent.ts.
  child.stdin.write(`${spec.prompt}\n`);
  child.stdin.end();

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    log(`HARD-KILLING after ${args.timeoutMs}ms — last stderr line:`);
    log(`  > ${lastStderrLine}`);
    child.kill("SIGKILL");
  }, args.timeoutMs);

  const exitInfo = await new Promise((r) => {
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      r({ code, signal, durationMs: Date.now() - startedAt });
    });
  });

  log("─".repeat(60));
  log(`exit: code=${exitInfo.code} signal=${exitInfo.signal} dur=${exitInfo.durationMs}ms timedOut=${timedOut}`);
  log(`stdout bytes: ${stdoutAll.length}, stderr bytes: ${stderrAll.length}`);
  if (timedOut && stderrAll.length === 0) {
    log("⚠ NO stderr emitted before timeout — agent hung BEFORE first log line");
    log("   (likely in createAgentRuntime / config load / SQLite open)");
  } else if (timedOut) {
    log(`⚠ HUNG — last stderr line was ${args.timeoutMs}ms ago`);
  }

  // 6. Postmortem: dump working-dir source files and save trace.
  log("─".repeat(60));
  log("WORKING DIR FILES:");
  dumpTreeAndReadSmallFiles(workingDir);

  log("─".repeat(60));
  const tracesDir = join(stateDir, "traces");
  const reportsDir = join(REPO_ROOT, "eval", "reports");
  if (existsSync(tracesDir)) {
    const traces = readdirSync(tracesDir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => ({
        name,
        full: join(tracesDir, name),
        mtime: statSync(join(tracesDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (traces.length === 0) {
      log("⚠ no NDJSON trace files in stateDir/traces/");
    } else {
      mkdirSync(reportsDir, { recursive: true });
      const target = join(reportsDir, `diagnose-${args.caseId}.ndjson`);
      copyFileSync(traces[0].full, target);
      log(`trace saved to ${relative(REPO_ROOT, target)} (${traces.length} candidate(s))`);
    }
  } else {
    log("⚠ no traces/ directory was created (agent never started a session)");
  }

  // 7. Cleanup workspace + daemon (if we started it).
  if (process.env.ATOMIC_AGENT_EVAL_KEEP_WORKSPACE === "1") {
    log(`keeping workspace at ${workspace} (ATOMIC_AGENT_EVAL_KEEP_WORKSPACE=1)`);
  } else {
    rmSync(workspace, { recursive: true, force: true });
  }
  if (daemon.startedByUs && process.env.ATOMIC_AGENT_EVAL_KEEP_DAEMON !== "1") {
    log(`stopping daemon (set ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 to keep it)`);
    runCli(["models", "stop"]);
  }

  process.exit(timedOut ? 1 : 0);
}

function dumpTreeAndReadSmallFiles(rootDir) {
  if (!existsSync(rootDir)) {
    log(`  (workingDir vanished: ${rootDir})`);
    return;
  }
  const entries = [];
  walk(rootDir, (full) => {
    const rel = relative(rootDir, full);
    const size = statSync(full).size;
    entries.push({ rel, full, size });
  });
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const { rel, full, size } of entries) {
    log(`  ${rel} (${size}B)`);
    if (size > 0 && size < 4096 && /\.(ts|tsx|js|mjs|json|md|txt)$/i.test(rel)) {
      const body = readFileSync(full, "utf8");
      for (const line of body.split("\n")) {
        console.log(`        │ ${line}`);
      }
    }
  }
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

main().catch((err) => {
  console.error(`[diag] fatal: ${err.stack ?? err.message ?? err}`);
  process.exit(2);
});
