import { spawn, type ChildProcess } from "node:child_process";

import { CappedOutput } from "./capped-output.js";
import { killProcessTree } from "./kill-process-tree.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * How long a stopped job has to honour `SIGTERM` before it is killed
 * outright. Long enough for a build tool to flush and remove its temp
 * files, short enough not to hold up a tool result.
 */
export const JOB_STOP_GRACE_MS = 2_000;

/** Per stream, head + tail (`CappedOutput`); 1 MiB. */
export const DEFAULT_JOB_OUTPUT_BYTES = 1024 * 1024;

/** How long `awaitJobExit` gives a stopped job to close: the grace plus a margin. */
export const JOB_EXIT_SETTLE_MS = JOB_STOP_GRACE_MS + 3_000;

export interface CommandJobOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Cap per stream; the head and the tail survive, the middle is dropped. */
  maxOutputBytes?: number;
}

export interface CommandJobExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** From the spawn to the close of the child's stdio. */
  durationMs: number;
}

export interface CommandJobOutput {
  stdout: string;
  stderr: string;
  /** Either stream dropped bytes to stay under its cap. */
  truncated: boolean;
}

/** Why `waitFor` returned: the child closed, the wait ran out, the signal fired. */
export type CommandJobWait = "exited" | "elapsed" | "aborted";

/**
 * A running command whose lifetime is not tied to one `await`: the
 * `os.shell.run` job that the default timeout detaches instead of
 * killing. Output keeps being captured after every `waitFor` returns,
 * so a later wait (or a kill) can report what happened in between.
 */
export interface CommandJob {
  readonly command: string;
  readonly args: readonly string[];
  readonly pid: number | undefined;
  readonly startedAt: number;
  /** Settles when the child's stdio closes; rejects when it could not be spawned. */
  readonly exit: Promise<CommandJobExit>;
  /** The exit once known, else `null`. */
  exited(): CommandJobExit | null;
  /** A snapshot of what both streams have produced so far. */
  output(): CommandJobOutput;
  /**
   * Wait up to `ms` (`0` = unbounded) for the child to close, or until
   * `signal` aborts — which returns promptly and leaves the child
   * running. Rejects only when the spawn itself failed.
   */
  waitFor(ms: number, signal?: AbortSignal): Promise<CommandJobWait>;
  /** A polite stop: `SIGTERM` to the group, `SIGKILL` after the grace. */
  stop(): void;
  /** `SIGKILL` to the group at once. */
  kill(): void;
}

/**
 * The job's exit, bounded. A job that was stopped answers within the
 * grace; one whose stdio is held open by something the group kill did
 * not reach (a `setsid` grandchild) is reported with a null exit after
 * `maxWaitMs` rather than holding a tool result forever. A job that
 * could not be spawned reports the same null exit — the spawn error
 * itself is delivered by the first `waitFor`.
 */
export async function awaitJobExit(
  job: CommandJob,
  maxWaitMs = JOB_EXIT_SETTLE_MS,
): Promise<CommandJobExit> {
  const known = job.exited();
  if (known) return known;
  await job.waitFor(maxWaitMs).catch(() => undefined);
  return (
    job.exited() ?? {
      exitCode: null,
      signal: null,
      durationMs: Date.now() - job.startedAt,
    }
  );
}

/**
 * Signal the child's whole process group. On POSIX the child leads its
 * own group (spawned `detached`), so `-pid` reaches everything the
 * command started — a subshell's `sleep 30 &` included. Without that a
 * background grandchild survives the kill and, still holding the stdio
 * pipes, keeps the job from closing until it exits on its own. A group
 * that is already gone falls back to the direct kill, a no-op then. On
 * Windows the tree-kill (`taskkill /T`) walks the descendants instead.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    killProcessTree(child, { force: signal === "SIGKILL" });
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group gone — fall through to the direct child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // process already exited
  }
}

/**
 * Spawn `command` in its own process group with both streams captured
 * into capped head + tail buffers. Nothing is written to stdin; it is
 * closed at once, so a command that reads it sees EOF.
 */
export function startCommandJob(
  command: string,
  args: string[],
  options: CommandJobOptions,
): CommandJob {
  const startedAt = Date.now();
  const cap = options.maxOutputBytes ?? DEFAULT_JOB_OUTPUT_BYTES;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // A group of its own on POSIX; on Windows `detached` would open a
    // console, and the tree-kill needs no group.
    ...(IS_WINDOWS ? { windowsHide: true } : { detached: true }),
  });
  const stdout = new CappedOutput(cap);
  const stderr = new CappedOutput(cap);
  let exit: CommandJobExit | null = null;
  let spawnError: Error | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStop = () => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  };

  const exitPromise = new Promise<CommandJobExit>((resolve, reject) => {
    child.on("error", (err) => {
      if (exit || spawnError) return;
      spawnError = err;
      clearStop();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (exit || spawnError) return;
      exit = {
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
      };
      clearStop();
      resolve(exit);
    });
  });
  // The rejection is delivered through `waitFor`; nobody may be
  // awaiting `exit` itself when a spawn fails.
  exitPromise.catch(() => undefined);

  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  // Nothing is written, so a far end that closed early is not an error.
  child.stdin.on("error", () => undefined);
  child.stdin.end();

  return {
    command,
    args,
    pid: child.pid,
    startedAt,
    exit: exitPromise,
    exited: () => exit,
    output: () => {
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      return {
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      };
    },
    waitFor(ms, signal) {
      if (spawnError) return Promise.reject(spawnError);
      if (exit) return Promise.resolve("exited");
      if (signal?.aborted) return Promise.resolve("aborted");
      return new Promise<CommandJobWait>((resolve, reject) => {
        const timer =
          ms > 0 && Number.isFinite(ms)
            ? setTimeout(() => settle("elapsed"), ms)
            : null;
        const onAbort = () => settle("aborted");
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const settle = (outcome: CommandJobWait) => {
          cleanup();
          resolve(outcome);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        exitPromise.then(
          () => settle("exited"),
          (err: unknown) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    },
    stop() {
      if (exit || spawnError || stopTimer) return;
      // A polite stop first, so a build tool can flush; the escalation
      // is armed regardless, because a polite stop is free to be ignored.
      signalGroup(child, "SIGTERM");
      stopTimer = setTimeout(() => signalGroup(child, "SIGKILL"), JOB_STOP_GRACE_MS);
    },
    kill() {
      if (exit || spawnError) return;
      clearStop();
      signalGroup(child, "SIGKILL");
    },
  };
}
