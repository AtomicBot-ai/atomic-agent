import { spawn } from "node:child_process";
import type { CliRunOptions } from "./run-cli-completion.js";
import {
  isEnoent,
  mapCliFailure,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";

/** Grace period between asking a child to stop and killing it. */
const SIGKILL_DELAY_MS = 2_000;
/** A single NDJSON line larger than this means the stream went wrong. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type CliStreamRunner = (
  options: CliRunOptions,
) => AsyncGenerator<string, void, void>;

/**
 * Spawn a CLI and yield its stdout one line at a time.
 *
 * Separate from `runCliCommand` because the buffered runner resolves
 * only once the process exits, which is exactly what streaming must
 * avoid. The generator's `finally` always kills the child, so a consumer
 * that abandons the iterator cannot leak a process.
 */
export const streamCliCommand: CliStreamRunner = async function* (options) {
  const child = spawn(options.binary, [...options.args], {
    cwd: options.cwd,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });

  let stderr = "";
  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  let settled = false;

  const stop = (reason: "timeout" | "abort" | "done") => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    // Escalate only if SIGTERM was not enough.
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, SIGKILL_DELAY_MS);
    killTimer.unref?.();
  };

  const timer =
    options.timeoutMs > 0 && Number.isFinite(options.timeoutMs)
      ? setTimeout(() => stop("timeout"), options.timeoutMs)
      : null;
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < options.maxOutputBytes) stderr += chunk;
  });

  const exited = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on("error", (err) => {
      settled = true;
      reject(
        isEnoent(err)
          ? new SubscriptionCliNotInstalledError(
              options.binary,
              options.installHint,
            )
          : err,
      );
    });
    child.on("close", (code) => {
      settled = true;
      resolve({ code });
    });
  });

  // The exit promise is awaited only after stdout drains, so attach a
  // no-op handler now: a spawn error (ENOENT) rejects immediately and
  // would otherwise be reported as an unhandled rejection before the
  // real await picks it up. Other awaiters still see the rejection.
  exited.catch(() => {});

  if (options.input !== undefined) child.stdin.write(options.input);
  child.stdin.end();

  child.stdout.setEncoding("utf8");
  let buffer = "";
  try {
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        throw new Error(
          `${options.binary} emitted a line larger than ${MAX_LINE_BYTES} bytes`,
        );
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }
    // A stream that ends without a trailing newline still has a line.
    if (buffer.length > 0) yield buffer;

    const { code } = await exited;
    if (code !== 0 || timedOut) {
      throw mapCliFailure({
        binary: options.binary,
        installHint: options.installHint,
        authHint: options.authHint,
        exitCode: code,
        stdout: "",
        stderr,
        timedOut,
        truncated: false,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!settled) stop("done");
    if (killTimer) clearTimeout(killTimer);
  }
};
