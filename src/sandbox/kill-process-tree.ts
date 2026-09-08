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
  /**
   * Whether the stop reached the whole tree — not whether the tree is
   * dead. (A process is free to ignore a polite stop; that is what the
   * caller's own escalation is for.)
   *
   * `true` when `taskkill` itself reported that it walked the tree, and
   * on POSIX, where there is no tree to walk because the child is the
   * process we mean. Every other outcome is `false`: taskkill refused,
   * could not be started, or we fell back to a signal at the wrapper's
   * own pid, which on Windows leaves the grandchild running. A caller
   * with an escalation armed must keep it armed on `false` — the direct
   * child's `close` is *not* evidence that its descendants are gone.
   */
  onTreeKilled?: (killed: boolean) => void;
}

/** The little of `ChildProcess` this needs; keeps fakes cheap in tests. */
export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * taskkill's "the process is not there" code. Nothing is left to kill,
 * so it counts as success — and, importantly, must not be escalated:
 * re-running taskkill against a pid that has already exited is the one
 * way this can reach an unrelated process, since Windows recycles pids.
 */
const TASKKILL_NOT_FOUND = 128;

export function killProcessTree(
  child: KillableChild,
  options: KillProcessTreeOptions = {},
): void {
  const force = options.force ?? false;
  const platform = options.platform ?? process.platform;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const report = options.onTreeKilled ?? (() => {});

  if (platform === "win32") {
    if (typeof child.pid === "number") {
      runTaskkill(child, child.pid, {
        force,
        spawnImpl: options.spawnImpl ?? spawn,
        report,
        mayEscalate: !force,
      });
      return;
    }
    killDirect(child, signal);
    // A signal at the wrapper is not a tree kill; say so.
    report(false);
    return;
  }

  killDirect(child, signal);
  report(true);
}

interface TaskkillRun {
  force: boolean;
  spawnImpl: typeof spawn;
  report: (killed: boolean) => void;
  /** Retry once with `/F` if this pass is refused. */
  mayEscalate: boolean;
}

/**
 * One `taskkill` pass, with its exit code actually read.
 *
 * Without `/F`, taskkill asks politely: it posts WM_CLOSE to the
 * target's windows. A console process started with `windowsHide: true`
 * has none, so taskkill answers "This process can only be terminated
 * forcefully (with /F option)" and exits non-zero — and with
 * `stdio: "ignore"` and nobody watching `close`, that refusal used to be
 * invisible, leaving the tree alive until (or unless) something else
 * escalated. So a refusal is retried once with `/F`.
 *
 * Untested on a real Windows host — see the PR's own note. The exit
 * codes are the documented ones (0 success, 128 no such process); any
 * other non-zero is treated as a refusal.
 */
function runTaskkill(
  child: KillableChild,
  pid: number,
  run: TaskkillRun,
): void {
  const args = ["/PID", String(pid), "/T", ...(run.force ? ["/F"] : [])];
  const signal: NodeJS.Signals = run.force ? "SIGKILL" : "SIGTERM";
  let taskkill;
  try {
    taskkill = run.spawnImpl("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // taskkill could not be spawned at all.
    killDirect(child, signal);
    run.report(false);
    return;
  }

  let settled = false;
  taskkill.on("error", () => {
    if (settled) return;
    settled = true;
    killDirect(child, signal);
    run.report(false);
  });
  taskkill.on("close", (code) => {
    if (settled) return;
    settled = true;
    if (code === 0 || code === TASKKILL_NOT_FOUND) {
      run.report(true);
      return;
    }
    if (run.mayEscalate) {
      runTaskkill(child, pid, { ...run, force: true, mayEscalate: false });
      return;
    }
    // Even `/F` could not do it (a permission problem, most likely).
    // The direct child is all we can still reach.
    killDirect(child, "SIGKILL");
    run.report(false);
  });
}

function killDirect(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // process already exited
  }
}
