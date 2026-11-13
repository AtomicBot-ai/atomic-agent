import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * Keep the computer awake for scheduled work (ATO-592).
 *
 *  - `off` (default): never hold anything; a task due while the computer
 *    slept still runs once on wake (`TaskStore.listDue` catch-up).
 *  - `while-working`: hold a sleep inhibitor only while a task drain or a
 *    turn (any surface: chat, Telegram, a scheduled task) runs.
 *
 * There is no "keep awake for as long as the agent runs" mode (decision
 * ATO-592): an idle agent never blocks sleep. The old `always` value is
 * rejected and treated as off, with a warning.
 *
 * The inhibitor is the operating system's own tool, started as a child
 * process tied to this process's pid, so it goes away even if the agent
 * is killed: `caffeinate -i -w <pid>` on macOS (idle sleep only; the
 * screen may still turn off) and `systemd-inhibit --what=idle:sleep` on
 * Linux when it is installed. Windows: nothing (the desktop app covers it
 * with Electron's power blocker). None of these stop a MacBook from
 * sleeping when its lid is closed.
 */
export type KeepAwakeMode = "off" | "while-working";

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ["off", "while-working"];

/**
 * Parse `ATOMIC_AGENT_TASKS_KEEP_AWAKE`; unknown or empty is `null`
 * (the removed `always` is unknown too).
 */
export function parseKeepAwakeMode(raw: string | undefined | null): KeepAwakeMode | null {
  const value = raw?.trim().toLowerCase().replace(/_/g, "-");
  if (!value) return null;
  if (value === "on" || value === "while-running") return "while-working";
  return (KEEP_AWAKE_MODES as readonly string[]).includes(value) ? (value as KeepAwakeMode) : null;
}

/** What the task runner and scheduler see. */
export interface KeepAwake {
  readonly mode: KeepAwakeMode;
  /** Hold for one drain or turn; call the returned function when it ends. */
  hold(): () => void;
  /** Whether an inhibitor process is running now (tests, status). */
  readonly active: boolean;
}

export interface InhibitorCommand {
  command: string;
  args: string[];
}

/** The inhibitor for this platform, or `null` where there is none. */
export function inhibitorCommand(platform: NodeJS.Platform, pid: number): InhibitorCommand | null {
  if (platform === "darwin") {
    return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=Atomic Agent",
        "--why=Running a scheduled task",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
    };
  }
  return null;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface KeepAwakeOptions {
  mode: KeepAwakeMode;
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: SpawnFn;
  logger?: StructuredLogger;
}

const NOOP_RELEASE = (): void => {};

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const mode = options.mode;
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const cmd =
    mode === "off" ? null : inhibitorCommand(options.platform ?? process.platform, options.pid ?? process.pid);
  let holds = 0;
  let child: ChildProcess | null = null;
  /** Set once the inhibitor could not start (not installed): stop trying. */
  let unavailable = cmd === null;

  const wanted = (): boolean => holds > 0;

  const startChild = (): void => {
    if (child || unavailable || !cmd) return;
    let proc: ChildProcess;
    try {
      proc = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: false });
    } catch (err) {
      giveUp(err);
      return;
    }
    child = proc;
    proc.once("error", (err) => {
      if (child === proc) child = null;
      giveUp(err);
    });
    proc.once("exit", (code) => {
      // We clear `child` before killing it, so an exit we did not ask for
      // means the tool refused (no polkit right, no logind): stop retrying.
      if (child !== proc) return;
      child = null;
      giveUp(new Error(`${cmd.command} exited with code ${String(code)}`));
    });
    proc.unref?.();
    options.logger?.info("keeping the computer awake", { mode, via: cmd.command });
  };

  const giveUp = (err: unknown): void => {
    if (unavailable) return;
    unavailable = true;
    options.logger?.warn("cannot keep the computer awake; tasks still catch up after sleep", {
      via: cmd?.command ?? "none",
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const stopChild = (): void => {
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };

  const sync = (): void => {
    if (wanted()) startChild();
    else stopChild();
  };

  return {
    mode,
    get active() {
      return child !== null;
    },
    hold() {
      if (mode !== "while-working") return NOOP_RELEASE;
      holds += 1;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        sync();
      };
    },
  };
}

/**
 * Wrap a turn entry point (`runTurn`, `executeTurn`) so the keep-awake is
 * held from the call until its promise settles (ATO-592: "while a task
 * or turn runs"). Holds nest by count, so a task turn inside a held
 * drain keeps one inhibitor.
 */
export function holdWhileRunning<A extends unknown[], R>(
  keepAwake: Pick<KeepAwake, "hold">,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const release = keepAwake.hold();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}
