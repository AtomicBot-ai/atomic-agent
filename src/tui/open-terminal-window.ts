import { spawn } from "node:child_process";
import { statSync } from "node:fs";
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
}

export type TerminalSpawn = (
  cmd: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; cwd?: string },
) => SpawnedTerminal;

export interface OpenTerminalWindowOptions {
  readonly cwd?: string;
  readonly spawn?: TerminalSpawn;
}

export async function openTerminalWindow(
  launch: TerminalLaunch,
  options: OpenTerminalWindowOptions = {},
): Promise<OpenTerminalWindowResult> {
  const spawnFn = options.spawn ?? (spawn as unknown as TerminalSpawn);
  let child: SpawnedTerminal;
  try {
    child = spawnFn(launch.cmd, launch.args, {
      detached: true,
      stdio: "ignore",
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (err) {
    return { ok: false, reason: `${launch.cmd}: ${errorMessage(err)}` };
  }
  return await new Promise<OpenTerminalWindowResult>((resolve) => {
    let settled = false;
    const settle = (result: OpenTerminalWindowResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", ((err: unknown) => {
      settle({ ok: false, reason: `${launch.cmd}: ${errorMessage(err)}` });
    }) as (...args: never[]) => void);
    child.once("spawn", (() => {
      // Detached + unref'd: the new window outlives this process, so
      // quitting the parent agent does not kill the one we just opened.
      try {
        child.unref();
      } catch {
        // A fake/limited child without unref is not a failure.
      }
      settle({ ok: true, label: launch.label });
    }) as (...args: never[]) => void);
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
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
