import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  buildTerminalLaunch,
  type TerminalLaunch,
  type TerminalLaunchInput,
} from "./build-terminal-launch.js";

/**
 * Opens a detached OS terminal window running a fresh `atomic-agent tui`
 * (Ctrl+N / `/window`). The spawn is injectable so the unit tests never
 * pop a window, and every failure comes back as a value — a broken
 * emulator must not take the render loop down with it.
 */

export type OpenTerminalWindowResult =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly reason: string };

/** Structural slice of `ChildProcess` this module actually uses. */
export interface SpawnedTerminal {
  once(event: string, listener: (...args: never[]) => void): unknown;
  unref(): void;
  /** Present when stderr is piped; absent on fakes that never fail. */
  readonly stderr?: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
  } | null;
}

export type TerminalSpawn = (
  cmd: string,
  args: readonly string[],
  options: {
    detached: boolean;
    stdio: readonly ["ignore", "ignore", "pipe"];
    cwd?: string;
    /** Only present when the launch pre-quoted its own cmd.exe line. */
    windowsVerbatimArguments?: boolean;
  },
) => SpawnedTerminal;

export interface OpenTerminalWindowOptions {
  readonly cwd?: string;
  readonly spawn?: TerminalSpawn;
  /**
   * How long a launcher may keep running before it counts as success.
   * osascript / gnome-terminal / wt exit quickly — code 0 on success,
   * non-zero with stderr on failure; direct emulators (xterm, kitty)
   * stay alive for the window's lifetime, which the timeout treats as
   * the window being genuinely open.
   */
  readonly settleMs?: number;
}

const DEFAULT_SETTLE_MS = 1_500;

export async function openTerminalWindow(
  launch: TerminalLaunch,
  options: OpenTerminalWindowOptions = {},
): Promise<OpenTerminalWindowResult> {
  const spawnFn = options.spawn ?? (spawn as unknown as TerminalSpawn);
  let child: SpawnedTerminal;
  try {
    child = spawnFn(launch.cmd, launch.args, {
      detached: true,
      // stderr is piped: a launcher that spawns fine and THEN fails
      // (an AppleScript error, a TCC denial, an unsupported flag) exits
      // non-zero with its reason there — the old spawn-event-as-success
      // reading reported "opened" for every one of those.
      stdio: ["ignore", "ignore", "pipe"] as const,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(launch.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (err) {
    return { ok: false, reason: `${launch.cmd}: ${errorMessage(err)}` };
  }
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  return await new Promise<OpenTerminalWindowResult>((resolve) => {
    let settled = false;
    let stderrTail = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: OpenTerminalWindowResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (result.ok) {
        // Detached + unref'd: the new window outlives this process, so
        // quitting the parent agent does not kill the one we just opened.
        try {
          child.unref();
        } catch {
          // A fake/limited child without unref is not a failure.
        }
      }
      resolve(result);
    };
    child.stderr?.on("data", (chunk: unknown) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-400);
    });
    child.once("error", ((err: unknown) => {
      settle({ ok: false, reason: `${launch.cmd}: ${errorMessage(err)}` });
    }) as (...args: never[]) => void);
    child.once("exit", ((code: unknown) => {
      if (code === 0) {
        settle({ ok: true, label: launch.label });
        return;
      }
      const detail = stderrTail.trim();
      settle({
        ok: false,
        reason: `${launch.cmd} exited with ${String(code)}${detail ? `: ${detail}` : ""}`,
      });
    }) as (...args: never[]) => void);
    // A launcher still running after the window is treated as a
    // successfully opened window (direct emulators live as long as it).
    timer = setTimeout(() => settle({ ok: true, label: launch.label }), settleMs);
  });
}

/** Build + open in one call. Returns the "nothing to open" reason as a value. */
export async function openAgentTerminalWindow(
  input: TerminalLaunchInput,
  options: OpenTerminalWindowOptions = {},
): Promise<OpenTerminalWindowResult> {
  const launch = buildTerminalLaunch(input);
  if (launch === null) {
    return {
      ok: false,
      reason:
        "no terminal emulator found — set $ATOMIC_AGENT_TERMINAL to the one you use",
    };
  }
  return await openTerminalWindow(launch, { cwd: input.cwd, ...options });
}

/**
 * Snapshot of the running process in the shape `buildTerminalLaunch`
 * wants. `isSeaBuild` is passed in rather than read from `node:sea`
 * here: that module is unresolvable under vitest's bundler, and this
 * file must stay unit-testable.
 */
export function currentTerminalLaunchInput(
  cwd: string,
  isSeaBuild: boolean,
): TerminalLaunchInput {
  return {
    platform: process.platform,
    execPath: process.execPath,
    argv: process.argv,
    execArgv: process.execArgv,
    isSea: isSeaBuild,
    cwd,
    env: process.env,
    hasBinary: isOnPath,
  };
}

/**
 * PATH probe without shelling out to `which` (which does not exist on
 * Windows and would cost a process per candidate emulator). An absolute
 * or relative path is checked as given.
 */
export function isOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (name.includes("/") || name.includes("\\")) return isExecutableFile(name);
  const entries = (env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  return entries.some((dir) => isExecutableFile(join(dir, name)));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // POSIX: a non-executable shadow file on PATH must not win the
    // probe. Windows has no X bit worth checking.
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
