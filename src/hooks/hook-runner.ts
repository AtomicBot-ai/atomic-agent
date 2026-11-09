import { spawn } from "node:child_process";
import { buildCommandEnv } from "../sandbox/command-env.js";
import type { HookCommand } from "./hook-types.js";

export interface HookRunResult {
  /** Process exit code; `null` when it was killed or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the command could not start or was cancelled. */
  spawnError?: string;
  durationMs: number;
}

export interface RunHookOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Override for tests; defaults to the filtered process environment. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Output kept per stream; a hook that prints more is cut. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Time a hook gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * Run one hook command with `input` as JSON on stdin.
 *
 * The child gets the same filtered environment as an agent shell command
 * (`buildCommandEnv`: no provider keys or other secret-looking variables),
 * plus `CLAUDE_PROJECT_DIR`, and for plugin hooks `CLAUDE_PLUGIN_ROOT` /
 * `CLAUDE_PLUGIN_DATA`. A hook that outlives its timeout is killed with its
 * whole process group and reported as `timedOut`; it never hangs the turn.
 */
export function runHookCommand(hook: HookCommand, input: unknown, options: RunHookOptions): Promise<HookRunResult> {
  const startedAt = Date.now();
  const env: NodeJS.ProcessEnv = {
    ...buildCommandEnv(options.baseEnv ?? process.env),
    CLAUDE_PROJECT_DIR: options.cwd,
    ATOMIC_AGENT_HOOK: "1",
  };
  if (hook.source.kind === "plugin") {
    env.CLAUDE_PLUGIN_ROOT = hook.source.root;
    env.CLAUDE_PLUGIN_DATA = hook.source.data;
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const posix = process.platform !== "win32";

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        ...(spawnError !== undefined ? { spawnError } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, {
        cwd: options.cwd,
        env,
        shell: true,
        // Own process group on POSIX, so a timeout kills the script's children too.
        detached: posix,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: (err as Error).message, durationMs: 0 });
      return;
    }

    const kill = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      // Do not wait for a process that ignores signals: report now.
      setTimeout(() => finish(null), KILL_GRACE_MS + 500).unref?.();
    }, hook.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      stop();
      finish(null, "cancelled");
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(timedOut ? null : code));

    // A hook that never reads stdin closes the pipe early: that is fine.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}
