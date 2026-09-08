import { spawn } from "node:child_process";
import { isBrokenPipe } from "../../../sandbox/index.js";
import { killProcessTree } from "../../../sandbox/kill-process-tree.js";
import { hostPlatform } from "./host-environment.js";
import type { CliRunOptions } from "./run-cli-completion.js";
import {
  isEnoent,
  isSpawnEinval,
  mapCliFailure,
  SubscriptionCliNotInstalledError,
  SubscriptionCliSpawnError,
} from "./subscription-cli-errors.js";
import { resolveWindowsCliInvocation } from "./windows-cli-shim.js";

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
 * avoid. The generator's `finally` always kills the child — the whole
 * process tree on Windows, where the child is a `cmd.exe` wrapper — so a
 * consumer that abandons the iterator cannot leak a process.
 */
export const streamCliCommand: CliStreamRunner = async function* (options) {
  // On Windows the vendor CLIs are `.cmd` shims, which spawn refuses to
  // start without a shell; elsewhere this hands the pair straight back.
  const invocation = resolveWindowsCliInvocation({
    binary: options.binary,
    args: options.args,
    installHint: options.installHint,
  });
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (err) {
    // Only ENOENT-class errnos reach the `error` event below; everything
    // else — EINVAL for a batch shim among them — is thrown right here,
    // out of `ChildProcess.prototype.spawn`, before any handler exists.
    if (isSpawnEinval(err)) {
      throw new SubscriptionCliSpawnError(options.binary, options.installHint);
    }
    if (isEnoent(err)) {
      throw new SubscriptionCliNotInstalledError(
        options.binary,
        options.installHint,
      );
    }
    throw err;
  }

  let stderr = "";
  let timedOut = false;
  let inputTruncated = false;
  let stdinError: Error | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let settled = false;

  const stop = (reason: "timeout" | "abort" | "done") => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    // Not `child.kill`: on Windows the direct child is `cmd.exe` and the
    // real CLI is a grandchild, so `TerminateProcess` on this pid alone
    // would leave it running — one orphan for every aborted turn, and
    // Ctrl+C is the most routine thing in the TUI. `killProcessTree`
    // walks the tree with `taskkill /T` there and is a plain
    // `child.kill` everywhere else.
    killProcessTree(child, { platform: hostPlatform() });
    // Escalate only if SIGTERM was not enough. A second `stop` (abort
    // followed by the generator's own cleanup) must not re-arm it, or
    // the first timer is orphaned and fires at a pid we no longer track.
    if (killTimer) return;
    killTimer = setTimeout(() => {
      killProcessTree(child, { force: true, platform: hostPlatform() });
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

  // Ctrl+C in the TUI runs `onAbort` -> `stop("abort")` -> SIGTERM while
  // a prompt past the pipe buffer (~64 KiB) is still draining, so the
  // write fails with EPIPE. An `error` on a stream with no listener is
  // fatal for the process, which would turn the most routine action in
  // the TUI — cancelling a turn — into a lost session. The broken pipe
  // is expected here; the child's exit code still reports the outcome.
  child.stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (isBrokenPipe(err)) {
      inputTruncated = true;
      return;
    }
    stdinError ??= err;
  });

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
    // A stdin failure that is not a broken pipe is a local fault, not
    // something the CLI's exit code explains — report it as itself.
    if (stdinError) throw stdinError;
    if (code !== 0 || timedOut || inputTruncated) {
      throw mapCliFailure({
        binary: options.binary,
        installHint: options.installHint,
        authHint: options.authHint,
        exitCode: code,
        stdout: "",
        stderr,
        timedOut,
        truncated: false,
        inputTruncated,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!settled) stop("done");
    // Cancel the SIGKILL escalation only once the child is actually
    // gone. Clearing it unconditionally cancelled the timer `stop` had
    // armed microseconds earlier, so a child that traps SIGTERM was
    // never force-killed and survived as an orphan — one per aborted
    // turn. While it is still alive, let the delay run and disarm on
    // exit instead.
    if (killTimer) {
      const armed = killTimer;
      const disarm = () => clearTimeout(armed);
      // `.then(f, f)` rather than `.finally`: the latter returns a
      // promise that re-throws, and nobody is left to await it here.
      if (settled) disarm();
      else void exited.then(disarm, disarm);
    }
  }
};
