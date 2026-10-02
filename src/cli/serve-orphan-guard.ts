/**
 * Keeps `atomic-agent serve` from outliving whoever started it.
 *
 * `serve` used to end on exactly two things: SIGINT and SIGTERM. Any
 * spawner that died without sending one — a SIGKILLed test harness, an
 * editor session that closed, a desktop app that crashed — left the
 * server running, reparented to init, holding its port and its sqlite
 * handles until the machine rebooted. On a Mac that had been up 81 days
 * this came to 23 of them, the oldest 16 days old, several still
 * holding sqlite files in scratch directories that no longer existed.
 *
 * This module is the fix proper: the server notices its own parent is
 * gone and shuts down the way SIGTERM would, so orphans stop being
 * created. `serve-reaper.ts` is the net underneath it, for the ones
 * already stranded — a net, not a substitute.
 */

/**
 * `EPERM` (POSIX) / `EACCES` (Windows) both mean the process exists but
 * belongs to someone else — still alive. Only `ESRCH` means dead. Same
 * probe as `local-llm/session-registry.ts`.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

export interface OrphanWatchOptions {
  /**
   * The pid to watch. Defaults to `process.ppid` at the moment of the
   * call, which is the right answer for every spawner that does not
   * double-fork; those pass `--parent-pid` instead.
   */
  readonly parentPid?: number;
  /**
   * True while the server is mid-turn. An orphan that is still working
   * for somebody keeps working: the watch re-checks instead of firing.
   */
  readonly isBusy?: () => boolean;
  readonly intervalMs?: number;
  /** Called once, when the server is both orphaned and idle. */
  readonly onOrphaned: () => void;
  /** Called once, the first time orphaning is seen while still busy. */
  readonly onOrphanedWhileBusy?: () => void;
}

/**
 * Watch for the parent going away. Returns a stop function.
 *
 * Abandonment is read two ways because the platforms differ. On POSIX
 * the kernel reparents an orphan, so `process.ppid` moving away from
 * what we booted with is exact and immune to pid reuse — and it holds
 * whether the orphan lands on init or on a subreaper, as under
 * `systemd --user` or a container init. Windows does not reparent, so
 * there the only signal is the watched process no longer existing.
 *
 * **The reparenting arm applies only to our actual parent.** An
 * explicit `--parent-pid` exists for spawners that double-fork, where
 * `process.ppid` is the intermediate and the pid we care about is the
 * grandparent: there `process.ppid !== watched` is true from the first
 * tick and forever, so reading it as abandonment would shut the server
 * down seconds after boot, every time. For an explicit pid, liveness is
 * the whole test.
 *
 * A server that is already parentless at boot (`ppid <= 1`, e.g. under
 * launchd or systemd) has nothing to watch. Note that this does *not*
 * cover `nohup cmd &` or `cmd & disown`: both keep the shell as parent,
 * so the watch arms and the server ends when that shell does. Use
 * `--no-parent-exit` to daemonise from a shell.
 *
 * Being abandoned is not on its own a reason to stop. If a turn is in
 * flight the watch keeps re-checking and shuts down once it lands: the
 * process that spawned us is not necessarily the one talking to us, and
 * work somebody is waiting on outranks tidiness.
 */
export function watchForOrphaning(opts: OrphanWatchOptions): () => void {
  const bootPpid = process.ppid;
  const watched = opts.parentPid ?? bootPpid;
  if (!Number.isInteger(watched) || watched <= 1) return () => {};
  // Only meaningful when we are watching the process that actually
  // spawned us; see the note on `--parent-pid` above.
  const watchesOwnParent = watched === bootPpid;

  let announced = false;
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const reparented = watchesOwnParent && process.ppid !== bootPpid;
    const orphaned = reparented || !isAlive(watched);
    if (!orphaned) return;
    if (opts.isBusy?.()) {
      if (!announced) {
        announced = true;
        opts.onOrphanedWhileBusy?.();
      }
      return;
    }
    fired = true;
    clearInterval(timer);
    opts.onOrphaned();
  }, opts.intervalMs ?? 2_000);
  // Never hold the event loop open on our account.
  timer.unref?.();
  return () => clearInterval(timer);
}
