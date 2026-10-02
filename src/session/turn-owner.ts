import { uptime } from "node:os";

/**
 * Who is running the turn a session row is marked `running` for.
 *
 * A turn used to exist only in memory until it ended: `executeTurn`
 * wrote the row once, from the finished state. Whatever stopped a turn
 * before that write — the app quitting mid-turn, a process killed
 * outright (Windows has no SIGTERM, the desktop's stop is a forced tree
 * kill there), a crash — left the row exactly as it was before the turn,
 * so a turn the user had sent, and that had been cancelled, read as a
 * session sitting there with nothing happening. `SessionStore.beginTurn`
 * now marks the row `running` and stores one of these beside it, and
 * the next runtime to boot can tell a mark whose process is gone from
 * one a live process still owns (`isTurnOwnerGone`).
 *
 * Stored as JSON in the `turn_owner` column, never in the payload: every
 * `save` rewrites the payload from whatever copy its caller holds, and a
 * mark that rode along in it would be dropped by the first save of a
 * copy taken before the turn began.
 */
export interface TurnOwner {
  /** The process running the turn. */
  readonly pid: number;
  /**
   * When the host last booted, in whole seconds since the epoch, as that
   * process saw it. A pid from an earlier boot names nobody, however
   * alive the process now holding that number is.
   */
  readonly bootAt: number;
  /** When the turn started, ms since the epoch. For diagnostics. */
  readonly at: number;
}

/** What `isTurnOwnerGone` compares a mark against: this host, right now. */
export interface TurnOwnerProbe {
  readonly pid: number;
  readonly bootAt: number;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * How far two readings of the boot time may drift apart and still be the
 * same boot. Each reading is `now - uptime`, so it moves with every step
 * of the wall clock; a couple of minutes covers NTP and rounding without
 * mistaking a reboot for the same boot.
 */
const SAME_BOOT_TOLERANCE_S = 120;

/**
 * When this host booted, in whole seconds since the epoch, or `0` when
 * the platform will not say (a mark with `bootAt: 0` is never judged by
 * its boot).
 */
export function hostBootAt(now: number = Date.now()): number {
  let up: number;
  try {
    up = uptime();
  } catch {
    return 0;
  }
  if (!Number.isFinite(up) || up <= 0) return 0;
  return Math.round(now / 1000 - up);
}

/** This process, as a mark and the sweep's probe see it. */
export function currentTurnOwnerProbe(): TurnOwnerProbe {
  return { pid: process.pid, bootAt: hostBootAt(), isAlive: isProcessAlive };
}

/** The stored form of a mark. */
export function serializeTurnOwner(owner: TurnOwner): string {
  return JSON.stringify({ pid: owner.pid, bootAt: owner.bootAt, at: owner.at });
}

/** A stored mark, or `null` when there is none or it does not parse. */
export function parseTurnOwner(raw: string | null): TurnOwner | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { pid, bootAt, at } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    bootAt: typeof bootAt === "number" && Number.isFinite(bootAt) ? bootAt : 0,
    at: typeof at === "number" && Number.isFinite(at) ? at : 0,
  };
}

/**
 * Whether the process a `running` row names can no longer be running
 * that turn — so the row is a turn that will never write its end.
 *
 * Meant for the boot sweep, before this process has started a turn of
 * its own: a mark carrying this process's pid then belongs to an earlier
 * process that had the same number (or to an earlier runtime in this one
 * that never got to release it), never to a live turn.
 *
 * Every test fails towards "still running": a mark that names a live pid
 * on this boot is left alone even when that pid may have been reused,
 * because cancelling a turn another window is still running is worse
 * than leaving a stale mark for the next boot. What does count as gone:
 *
 *  - no mark, or one that does not parse — a live status no turn claims
 *    (`beginTurn` never writes `running` without a mark; a plain `save`
 *    of a copy read mid-turn is the only other way one gets there);
 *  - this process's pid (see above);
 *  - a different boot of the host;
 *  - a pid with no process behind it.
 */
export function isTurnOwnerGone(
  raw: string | null,
  probe: TurnOwnerProbe,
): boolean {
  const owner = parseTurnOwner(raw);
  if (owner === null) return true;
  if (owner.pid === probe.pid) return true;
  if (
    owner.bootAt > 0 &&
    probe.bootAt > 0 &&
    Math.abs(owner.bootAt - probe.bootAt) > SAME_BOOT_TOLERANCE_S
  ) {
    return true;
  }
  return !probe.isAlive(owner.pid);
}

/**
 * `EPERM` (POSIX) / `EACCES` (Windows) both mean the process exists but
 * belongs to someone else — still alive. Only `ESRCH` means dead. Same
 * probe as `cli/serve-orphan-guard.ts`.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}
