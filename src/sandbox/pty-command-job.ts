import { constants as osConstants } from "node:os";

import type { NodePtyModule, NodePtyProcess } from "../native/load-node-pty.js";
import { CappedOutput } from "./capped-output.js";
import { buildCommandEnv } from "./command-env.js";
import {
  DEFAULT_JOB_OUTPUT_BYTES,
  JOB_STOP_GRACE_MS,
  type CommandJob,
  type CommandJobExit,
  type CommandJobOutputListener,
  type CommandJobWait,
} from "./command-job.js";
import { killProcessTree } from "./kill-process-tree.js";
import { descendantPids, signalPids } from "./process-descendants.js";

/**
 * A command job on a real pseudo-terminal (ATO-2484): node-pty, which is
 * a pty on macOS and Linux and ConPTY on Windows. The same `CommandJob`
 * contract as `startCommandJob`, so the shell job registry, `wait`,
 * `write`, `kill` and `until` work unchanged; on top of it the job has a
 * terminal size that `resize` changes (a desktop terminal tab that
 * follows its window, ATO-2485).
 *
 * A terminal has one output stream: what the program writes to stdout
 * and to stderr arrives mixed, as on a screen, and is reported as
 * stdout. Typed input goes through the terminal's line discipline, so
 * Enter is `\r` (a `\n` the model types is sent as `\r`), and the end of
 * input is the terminal's EOF key (Ctrl+D, on Windows Ctrl+Z Enter).
 */

/** The size a pty job starts at: wide enough for most tools' tables. */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 40;
const MAX_PTY_COLS = 1_000;
const MAX_PTY_ROWS = 500;

export interface PtyCommandJobOptions {
  cwd: string;
  /** As for `startCommandJob`: omitted, the filtered env (`buildCommandEnv`). */
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  cols?: number;
  rows?: number;
  /**
   * Windows only: `args` is a ready `cmd.exe` command line
   * (`buildSubshellInvocation`), passed to ConPTY as it is.
   */
  windowsVerbatimArguments?: boolean;
  /** Test seam: the platform whose stop and EOF rules apply. */
  platform?: NodeJS.Platform;
}

/** A `CommandJob` with a terminal: its size and a way to change it. */
export interface PtyCommandJob extends CommandJob {
  /** Change the terminal size; `false` once the job is gone. */
  resize(cols: number, rows: number): boolean;
  terminalSize(): { cols: number; rows: number };
  /**
   * The error when the pty refused to start the program at all (ConPTY
   * found no such file), else `null`. The caller may fall back to pipes.
   */
  startError(): Error | null;
}

function clampSize(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** A pty wants string values only; unset names are left out. */
function ptyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

function signalName(signal: number | undefined): NodeJS.Signals | null {
  if (typeof signal !== "number" || signal === 0) return null;
  for (const [name, num] of Object.entries(osConstants.signals)) {
    if (num === signal) return name as NodeJS.Signals;
  }
  return null;
}

/** What Enter is at a terminal: a typed `\n` (or `\r\n`) becomes `\r`. */
export function toTerminalKeys(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

/** The terminal's end-of-input key. */
export function terminalEof(platform: NodeJS.Platform): string {
  return platform === "win32" ? "\u001a\r" : "\u0004";
}

export function startPtyCommandJob(
  pty: NodePtyModule,
  command: string,
  args: string[],
  options: PtyCommandJobOptions,
): PtyCommandJob {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const startedAt = Date.now();
  const output = new CappedOutput(options.maxOutputBytes ?? DEFAULT_JOB_OUTPUT_BYTES);
  const env = options.env ?? buildCommandEnv(process.env);
  let cols = clampSize(options.cols, DEFAULT_PTY_COLS, MAX_PTY_COLS);
  let rows = clampSize(options.rows, DEFAULT_PTY_ROWS, MAX_PTY_ROWS);
  let exit: CommandJobExit | null = null;
  let spawnError: Error | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let inputOpen = true;
  const listeners = new Set<CommandJobOutputListener>();
  let settleExit: (value: CommandJobExit) => void = () => undefined;
  let failExit: (err: Error) => void = () => undefined;
  const exitPromise = new Promise<CommandJobExit>((resolve, reject) => {
    settleExit = resolve;
    failExit = reject;
  });
  exitPromise.catch(() => undefined);
  const clearStop = () => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  };

  let proc: NodePtyProcess | null = null;
  try {
    proc = pty.spawn(
      command,
      isWindows && options.windowsVerbatimArguments === true ? args.join(" ") : args,
      { name: env.TERM ?? "dumb", cols, rows, cwd: options.cwd, env: ptyEnv(env) },
    );
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err));
    failExit(spawnError);
  }

  if (proc !== null) {
    proc.onData((text) => {
      output.append(Buffer.from(text, "utf8"));
      for (const listener of listeners) listener(text, "stdout");
    });
    proc.onExit(({ exitCode, signal }) => {
      if (exit || spawnError) return;
      const name = signalName(signal);
      exit = {
        exitCode: name === null ? exitCode : null,
        signal: name,
        durationMs: Date.now() - startedAt,
      };
      inputOpen = false;
      clearStop();
      settleExit(exit);
    });
  }
  const live = () => proc !== null && exit === null && spawnError === null;
  const pid = proc?.pid;

  // POSIX: node-pty starts the program as the leader of its own session
  // and process group, so `-pid` reaches what it started; the descendant
  // walk catches a child that moved to a group of its own.
  const signalTree = (signal: NodeJS.Signals) => {
    if (typeof pid !== "number") return;
    signalPids(descendantPids(pid), signal);
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // gone already
      }
    }
  };
  // Windows: `taskkill /T` walks the tree; closing the pty ends what is
  // left attached to its console.
  const endWindowsTree = (force: boolean) => {
    if (proc === null) return;
    const owner = proc;
    const closePty = () => {
      try {
        owner.kill();
      } catch {
        // the pty is closed already
      }
      return true;
    };
    killProcessTree({ pid, kill: closePty }, { force, platform });
    if (force) closePty();
  };

  return {
    command,
    args,
    pid,
    startedAt,
    exit: exitPromise,
    exited: () => exit,
    output: () => {
      const snap = output.snapshot();
      return { stdout: snap.text, stderr: "", truncated: snap.truncated };
    },
    onOutput(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write(text) {
      if (!inputOpen || !live()) return false;
      proc!.write(toTerminalKeys(text));
      return true;
    },
    endInput() {
      if (!inputOpen) return;
      inputOpen = false;
      if (live()) proc!.write(terminalEof(platform));
    },
    waitFor(ms, signal): Promise<CommandJobWait> {
      if (spawnError) return Promise.reject(spawnError);
      if (exit) return Promise.resolve("exited");
      if (signal?.aborted) return Promise.resolve("aborted");
      return new Promise<CommandJobWait>((resolve, reject) => {
        const timer = ms > 0 && Number.isFinite(ms) ? setTimeout(() => settle("elapsed"), ms) : null;
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
      if (!live() || stopTimer) return;
      if (isWindows) {
        endWindowsTree(false);
        stopTimer = setTimeout(() => endWindowsTree(true), JOB_STOP_GRACE_MS);
        return;
      }
      signalTree("SIGTERM");
      stopTimer = setTimeout(() => signalTree("SIGKILL"), JOB_STOP_GRACE_MS);
    },
    kill() {
      if (!live()) return;
      clearStop();
      if (isWindows) endWindowsTree(true);
      else signalTree("SIGKILL");
    },
    resize(nextCols, nextRows) {
      if (!live()) return false;
      cols = clampSize(nextCols, cols, MAX_PTY_COLS);
      rows = clampSize(nextRows, rows, MAX_PTY_ROWS);
      try {
        proc!.resize(cols, rows);
      } catch {
        return false;
      }
      return true;
    },
    terminalSize: () => ({ cols, rows }),
    startError: () => (proc === null ? spawnError : null),
  };
}
