import { spawn } from "node:child_process";

/**
 * Stop a child *and everything it started*.
 *
 * On POSIX this is `child.kill(signal)` and nothing more. On Windows it
 * cannot be: `child.kill` is `TerminateProcess` against that one pid, so
 * a child that is really a subshell (`cmd.exe -> node -> …`, which is
 * exactly what the Windows CLI shim produces) loses its parent and keeps
 * running. `taskkill /T` walks the tree instead; if taskkill itself
 * cannot be spawned — no pid left, the executable missing from a locked
 * down image — fall back to signalling the direct child, which is still
 * better than nothing.
 *
 * `platform` and `spawnImpl` are parameters so the win32 branch is
 * exercised from a macOS/Linux test run.
 */
export interface KillProcessTreeOptions {
  /** `taskkill /F` / `SIGKILL` rather than a polite stop. */
  force?: boolean;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
}

/** The little of `ChildProcess` this needs; keeps fakes cheap in tests. */
export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function killProcessTree(
  child: KillableChild,
  options: KillProcessTreeOptions = {},
): void {
  const force = options.force ?? false;
  const platform = options.platform ?? process.platform;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";

  if (platform === "win32" && typeof child.pid === "number") {
    const spawnImpl = options.spawnImpl ?? spawn;
    const args = ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])];
    try {
      spawnImpl("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => killDirect(child, signal));
      return;
    } catch {
      // taskkill could not be spawned at all — fall through.
    }
  }

  killDirect(child, signal);
}

function killDirect(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // process already exited
  }
}
