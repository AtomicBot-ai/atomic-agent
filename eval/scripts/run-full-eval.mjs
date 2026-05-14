#!/usr/bin/env node
// One-shot full-eval runner against the real managed llama-server.
//
// Flow:
//   1. Resolve managed.port + managed.modelId from `atomic-agent models status`
//      (no env wrangling, no hand-edited config).
//   2. If the daemon is not healthy, run `atomic-agent models start` and
//      wait for `/health` to return 200.
//   3. Spawn `vitest --config eval/vitest.config.ts` with
//      `ATOMIC_AGENT_EVAL_LLAMA_URL=http://127.0.0.1:<port>`.
//   4. Tear the daemon down on the way out — but ONLY when this script
//      started it. If the daemon was already running, leave it running.
//
// Usage:
//   npm run eval:full
//   ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 npm run eval:full   # keep daemon up after the run
//   ATOMIC_AGENT_EVAL_LLAMA_URL=http://...  npm run eval:full   # bypass managed mode entirely

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");

const log = (msg) => console.error(`[eval:full] ${msg}`);

function runCli(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function parseStatus(stdout) {
  const port = stdout.match(/port\s+(\d+)|:(\d{4,5})/);
  const portValue = port ? Number(port[1] ?? port[2]) : null;
  const modelMatch = stdout.match(/active model:\s*(\S+)/);
  const healthMatch = stdout.match(/health:\s*(\S+)/);
  const daemonMatch = stdout.match(/daemon:\s*(\S+)/);
  const urlMatch = stdout.match(/http:\/\/[^\s]+/);
  return {
    port: portValue,
    modelId: modelMatch?.[1] ?? null,
    health: healthMatch?.[1] ?? null,
    daemon: daemonMatch?.[1] ?? null,
    url: urlMatch?.[0] ?? null,
  };
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not become healthy at ${url} in ${timeoutMs}ms`);
}

async function main() {
  const overrideUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  if (overrideUrl) {
    log(`using ATOMIC_AGENT_EVAL_LLAMA_URL=${overrideUrl} (skipping managed daemon control)`);
    await waitForHealth(overrideUrl, 5_000).catch((err) => {
      log(`warning: ${err.message}`);
    });
    return runVitest(overrideUrl);
  }

  const status0 = runCli(["models", "status"], { capture: true });
  if (status0.status !== 0) {
    log(`\`atomic-agent models status\` failed:\n${status0.stderr || status0.stdout}`);
    return 2;
  }
  const info = parseStatus(status0.stdout);
  if (!info.port) {
    log(`could not parse managed port from:\n${status0.stdout}`);
    return 2;
  }
  const baseUrl = `http://127.0.0.1:${info.port}`;
  log(`managed daemon: model=${info.modelId} port=${info.port} health=${info.health}`);

  const startedByUs = info.health !== "up";
  if (startedByUs) {
    log("daemon is down, starting (this can take 30-90s on first load)...");
    const start = runCli(["models", "start"]);
    if (start.status !== 0) {
      log(`\`atomic-agent models start\` exited with code ${start.status}`);
      return 2;
    }
  } else {
    log("daemon already healthy, reusing it");
  }

  await waitForHealth(baseUrl, 120_000);
  log(`llama-server healthy at ${baseUrl}, launching vitest...`);

  let exitCode = 1;
  try {
    exitCode = await runVitest(baseUrl);
  } finally {
    if (startedByUs && process.env.ATOMIC_AGENT_EVAL_KEEP_DAEMON !== "1") {
      log("stopping managed daemon (set ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 to keep it running)");
      runCli(["models", "stop"]);
    } else if (startedByUs) {
      log("ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 — leaving daemon up");
    }
  }
  return exitCode;
}

function runVitest(baseUrl) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "npx",
      ["vitest", "run", "--config", "eval/vitest.config.ts"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ATOMIC_AGENT_EVAL_LLAMA_URL: baseUrl },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

let cleaningUp = false;
function onSignal(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  log(`received ${signal}, stopping managed daemon`);
  try {
    runCli(["models", "stop"]);
  } catch {
    // best-effort
  }
  process.exit(130);
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    try {
      runCli(["models", "stop"]);
    } catch {
      // best-effort
    }
    process.exit(1);
  });
