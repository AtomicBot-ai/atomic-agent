import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which process runs due tasks when several share one state dir (ATO-416).
 *
 * The desktop app (its bundled `atag serve`) and the terminal TUI run on
 * the same `~/.atomic-agent` at once, each with its own `Scheduler`.
 * Claiming a task is atomic, so nothing runs twice, but a task could run
 * in whichever process ticked first — including the one without the
 * Telegram bot, where its `notify: "telegram"` report has no channel to
 * go out on. Product decision: whoever started first leads.
 *
 *  - Telegram wanted here (a token and the channel not disabled): the
 *    live process holding `<stateDir>/telegram.lock` leads. It also takes
 *    `scheduler.lock`, so a process that does not run Telegram defers to
 *    it as well (once it has it: a non-Telegram process that already
 *    held `scheduler.lock` keeps leading too until it exits — the
 *    behaviour before this module, harmless with atomic claiming); a
 *    process that wants Telegram but lost that lock gives
 *    `scheduler.lock` up and stands by.
 *  - Otherwise, or while nobody holds `telegram.lock` (a reconnect gap —
 *    the channel releases it between attempts): the holder of
 *    `<stateDir>/scheduler.lock` leads. Same take-over as
 *    `TelegramLockfile`: the file holds the holder's pid, others wait,
 *    and a dead holder's file is taken over.
 *
 * Asked again on every tick, so leadership follows the locks as they
 * move: when the leader exits, the next tick of the other process takes
 * over. A tick already running finishes; two processes may overlap for
 * one tick around a hand-over, which atomic claiming makes harmless.
 * A single process always leads, exactly as before this module.
 *
 * Fails open: if the lock file cannot be created at all (state dir not
 * writable), this process leads, as it did before.
 *
 * Residual case shared with `TelegramLockfile`: a pid left in a lock by a
 * killed holder that the OS recycles onto an unrelated live process
 * keeps the lock "held" until the file is deleted by hand.
 */
export interface SchedulerLeadership {
  /** Whether this process should run due tasks on this tick. */
  isLeader(): boolean;
  /** Give up `scheduler.lock` if this process holds it. Idempotent. */
  release(): void;
}

export const SCHEDULER_LOCK_FILE = "scheduler.lock";
/** `TelegramChannel`'s default lock path inside the state dir. */
export const TELEGRAM_LOCK_FILE = "telegram.lock";

export interface SchedulerLeadershipOptions {
  stateDir: string;
  /**
   * Whether this process runs (or is trying to run) the Telegram channel.
   * Read on every tick: the channel can be switched on and off live.
   */
  telegramWanted: () => boolean;
  /** Test seams: this process's pid and the liveness probe. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export function createSchedulerLeadership(
  options: SchedulerLeadershipOptions,
): SchedulerLeadership {
  const self = options.pid ?? process.pid;
  const alive = options.isAlive ?? isAlive;
  const schedulerLock = join(options.stateDir, SCHEDULER_LOCK_FILE);
  const telegramLock = join(options.stateDir, TELEGRAM_LOCK_FILE);

  const liveHolder = (path: string): number | null => {
    const pid = readHolder(path);
    return pid !== null && (pid === self || alive(pid)) ? pid : null;
  };

  const holdSchedulerLock = (): boolean => {
    try {
      writeFileSync(schedulerLock, String(self), { flag: "wx" });
      return true;
    } catch (err) {
      // Not "someone has it" but "there is no lock to have": run, as before.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return true;
    }
    const holder = readHolder(schedulerLock);
    if (holder === self) return true;
    if (holder !== null && alive(holder)) return false;
    // Dead holder or unreadable file: take over. Two processes taking
    // over at once both write; the last write wins, and the loser sees
    // the winner's pid here and on its next tick.
    try {
      writeFileSync(schedulerLock, String(self));
    } catch {
      return true;
    }
    return readHolder(schedulerLock) === self;
  };

  const release = (): void => {
    try {
      // Only the owner removes the file (same rule as TelegramLockfile).
      if (readHolder(schedulerLock) === self) unlinkSync(schedulerLock);
    } catch {
      // best-effort: a file left behind is taken over once we are dead
    }
  };

  return {
    isLeader(): boolean {
      if (options.telegramWanted()) {
        const holder = liveHolder(telegramLock);
        if (holder === self) {
          holdSchedulerLock();
          return true;
        }
        if (holder !== null) {
          release();
          return false;
        }
      }
      return holdSchedulerLock();
    },
    release,
  };
}

function readHolder(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(text, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // `EPERM` (POSIX) / `EACCES` (Windows): alive, owned by someone else.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}
