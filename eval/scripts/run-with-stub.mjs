#!/usr/bin/env node
// Boots the eval llama stub, waits for /health, runs `vitest --config
// eval/vitest.config.ts`, and tears the stub down on exit. Intended for
// harness smoke-tests when no real llama-server is available locally.
//
// Usage: `npm run eval:with-stub` (or `node eval/scripts/run-with-stub.mjs`).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const STUB_PATH = resolve(HERE, "stub-llama-server.mjs");
const PORT = Number(process.env.ATOMIC_AGENT_EVAL_STUB_PORT ?? 18991);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const stub = spawn(process.execPath, [STUB_PATH, "--port", String(PORT)], {
  cwd: REPO_ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});

let stubExited = false;
stub.on("exit", (code, signal) => {
  stubExited = true;
  if (code !== null && code !== 0) {
    console.error(`[eval-stub] exited unexpectedly with code ${code}`);
  } else if (signal) {
    console.error(`[eval-stub] terminated by signal ${signal}`);
  }
});

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stubExited) {
      throw new Error("stub server exited before becoming healthy");
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stub server did not become healthy in ${timeoutMs}ms`);
}

function stopStub() {
  if (stubExited) return;
  stub.kill("SIGTERM");
}

let exitCode = 1;
try {
  await waitForHealth(5_000);

  const vitest = spawn(
    "npx",
    ["vitest", "run", "--config", "eval/vitest.config.ts"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ATOMIC_AGENT_EVAL_LLAMA_URL: BASE_URL },
      stdio: "inherit",
    },
  );

  exitCode = await new Promise((r) => {
    vitest.on("exit", (code) => r(code ?? 1));
  });
} catch (err) {
  console.error(`[eval:with-stub] ${err instanceof Error ? err.message : err}`);
} finally {
  stopStub();
}

process.exit(exitCode);
