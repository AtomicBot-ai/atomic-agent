// Shared daemon-lifecycle + vitest-spawn helpers for memory-eval
// orchestrator scripts. Mirrors the eval/scripts/run-full-eval.mjs
// flow but factored so E1..E4 scripts stay tiny.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");
export const VITEST_CONFIG = resolve(REPO_ROOT, "eval-memory", "vitest.config.ts");
export const ENV_FILE = resolve(REPO_ROOT, "eval-memory", ".env");

export function makeLog(tag) {
  return (msg) => console.error(`[eval-memory:${tag}] ${msg}`);
}

export function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.error(`[eval-memory] failed to load ${ENV_FILE}: ${err?.message ?? err}`);
  }
}

export function runCli(args, { capture = false } = {}) {
  if (!existsSync(CLI_BIN)) {
    console.error(`[eval-memory] dist/cli/index.js missing — run \`npm run build\` first`);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function parseStatus(stdout) {
  const portMatch = stdout.match(/port\s+(\d+)|:(\d{4,5})/);
  return {
    port: portMatch ? Number(portMatch[1] ?? portMatch[2]) : null,
    modelId: stdout.match(/active model:\s*(\S+)/)?.[1] ?? null,
    health: stdout.match(/health:\s*(\S+)/)?.[1] ?? null,
  };
}

export async function probeUrl(url, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url, 2000)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server not healthy at ${url} in ${timeoutMs}ms`);
}

/**
 * Resolve chat llama URL. Returns null on failure (caller decides
 * what to do — most E* scripts treat null as "skip experiment").
 *
 * Returns: { url, startedByUs, embedUrl }.
 */
export async function bringUpDaemon(log, { skipManaged = false } = {}) {
  if (process.env.ATOMIC_AGENT_EVAL_LLAMA_URL) {
    log(`ATOMIC_AGENT_EVAL_LLAMA_URL=${process.env.ATOMIC_AGENT_EVAL_LLAMA_URL} (skipping managed daemon control)`);
    return {
      url: process.env.ATOMIC_AGENT_EVAL_LLAMA_URL,
      startedByUs: false,
      embedUrl: process.env.ATOMIC_AGENT_EVAL_EMBED_URL ?? null,
    };
  }
  if (skipManaged) return { url: null, startedByUs: false, embedUrl: null };

  const status0 = runCli(["models", "status"], { capture: true });
  if (status0.status !== 0) {
    log(`\`atomic-agent models status\` failed:\n${status0.stderr || status0.stdout}`);
    return { url: null, startedByUs: false, embedUrl: null };
  }
  const info = parseStatus(status0.stdout);
  if (!info.port) {
    log(`could not parse managed port from:\n${status0.stdout}`);
    return { url: null, startedByUs: false, embedUrl: null };
  }
  const chatUrl = `http://127.0.0.1:${info.port}`;
  const startedByUs = info.health !== "up";
  if (startedByUs) {
    log(`chat daemon down — starting (this can take 30-90s on cold start)...`);
    const start = runCli(["models", "start"]);
    if (start.status !== 0) {
      log(`\`atomic-agent models start\` exited with code ${start.status}`);
      return { url: null, startedByUs: false, embedUrl: null };
    }
  } else {
    log(`chat daemon already healthy at ${chatUrl}, reusing it`);
  }
  try {
    await waitForHealth(chatUrl, 120_000);
  } catch (err) {
    log(`chat health check failed: ${err.message}`);
    return { url: chatUrl, startedByUs, embedUrl: null };
  }

  let embedUrl = null;
  for (const url of [
    process.env.ATOMIC_AGENT_EVAL_EMBED_URL,
    "http://127.0.0.1:18992",
    "http://127.0.0.1:19092",
  ].filter(Boolean)) {
    if (await probeUrl(url)) {
      embedUrl = url;
      log(`embedding daemon reachable at ${url}`);
      break;
    }
  }
  if (!embedUrl) log(`no embedding daemon reachable (chat-only mode)`);
  return { url: chatUrl, startedByUs, embedUrl };
}

export function teardownDaemon(log, startedByUs) {
  if (!startedByUs) {
    log(`daemon was already up when we started — leaving it running`);
    return;
  }
  if (process.env.ATOMIC_AGENT_EVAL_KEEP_DAEMON === "1") {
    log(`ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 — leaving daemon up`);
    return;
  }
  log(`stopping managed daemon`);
  try {
    runCli(["models", "stop"]);
  } catch (err) {
    log(`stop failed (best-effort): ${err?.message ?? err}`);
  }
}

export function runVitest({ filter = [], extraEnv = {}, forwarded = [] }) {
  return new Promise((resolveExit) => {
    const args = ["vitest", "run", "--config", VITEST_CONFIG, ...filter, ...forwarded];
    const child = spawn("npx", args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

export function installSignalHandlers(log) {
  let cleaningUp = false;
  function onSignal(signal) {
    if (cleaningUp) return;
    cleaningUp = true;
    log(`received ${signal}, stopping managed daemon`);
    try {
      runCli(["models", "stop"]);
    } catch { /* best-effort */ }
    process.exit(130);
  }
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
