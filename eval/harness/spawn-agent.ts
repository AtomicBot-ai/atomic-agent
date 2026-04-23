import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const DIST_CLI = resolve(REPO_ROOT, "dist", "cli", "index.js");
const SRC_CLI = resolve(REPO_ROOT, "src", "cli", "index.ts");

export interface SpawnAgentOptions {
  workingDir: string;
  stateDir: string;
  prompt: string;
  maxSteps: number;
  /** Hard wall-clock cap; aborts the child on overrun. */
  timeoutMs: number;
}

export interface SpawnAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True if we killed the child because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Wall-clock duration of the subprocess. */
  durationMs: number;
}

/**
 * Spawn `atomic-agent run --cwd <workingDir> --no-approval` as a real
 * subprocess, write `prompt` + EOF to its stdin, and capture the streams.
 *
 * We talk to the CLI exactly like a human would (one line in, one reply
 * line out) so the harness exercises the same surface that ships to
 * users — not a shortcut around the runtime.
 *
 * Resolution order for the CLI binary:
 *   1. `dist/cli/index.js` (fast path, used after `npm run build`)
 *   2. `tsx src/cli/index.ts` (dev path, no build required)
 */
export function spawnAgentRun(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  return new Promise((resolveResult, rejectResult) => {
    const usingDist = existsSync(DIST_CLI);
    const command = usingDist ? process.execPath : TSX_BIN;
    const args = usingDist
      ? [DIST_CLI, "run", "--cwd", opts.workingDir, "--no-approval", "--max-steps", String(opts.maxSteps)]
      : [SRC_CLI, "run", "--cwd", opts.workingDir, "--no-approval", "--max-steps", String(opts.maxSteps)];

    if (!usingDist && !existsSync(TSX_BIN)) {
      rejectResult(
        new Error(
          `cannot locate eval CLI: neither ${DIST_CLI} nor ${TSX_BIN} exist. Run \`npm install\` (and optionally \`npm run build\`) first.`,
        ),
      );
      return;
    }

    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ATOMIC_AGENT_STATE_DIR: opts.stateDir,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      rejectResult(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolveResult({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.stdin.write(`${opts.prompt}\n`);
    child.stdin.write("/quit\n");
    child.stdin.end();
  });
}
