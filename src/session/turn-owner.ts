import { readFileSync } from "node:fs";
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
   * The host's uptime, in seconds, when the mark was written. A host
   * whose uptime is now lower has rebooted since, so the pid names
   * nobody, however alive the process holding that number now is. The
   * uptime counts from boot on its own clock, so stepping the wall clock
   * does not move it — a boot time worked out from the wall clock did,
   * and could make a live owner look like one from an earlier boot.
   * Absent when the platform would not say.
   */
  readonly hostUptime?: number;
  /**
   * When the owning process started, in the kernel's own units, where
   * that can be read cheaply (Linux: `/proc/<pid>/stat`). Together with
   * the pid it names exactly one process for as long as the host is up,
   * so a pid reused by another process is caught. Absent elsewhere.
   */
  readonly startTicks?: string;
  /** When the turn started, ms since the epoch. For diagnostics. */
  readonly at: number;
}

/**
 * This process and host: what a mark records about the turn's owner, and
 * what `isTurnOwnerGone` compares a mark against. Functions, not values,
 * so each mark and each sweep reads the host as it is at that moment.
 */
export interface TurnOwnerProbe {
  readonly pid: number;
  /** The host's uptime now, in seconds; `undefined` when unknown. */
  readonly hostUptime: () => number | undefined;
  readonly isAlive: (pid: number) => boolean;
  /** The start of process `pid` as `TurnOwner.startTicks` records it, or `null`. */
  readonly startTicksOf: (pid: number) => string | null;
}

/**
 * Slack for the uptime comparison: uptime is whole seconds on some
 * platforms, and two readings a moment apart can differ by one.
 */
const UPTIME_SLACK_S = 5;

/** The host's uptime in seconds, or `undefined` when the platform will not say. */
export function hostUptime(): number | undefined {
  try {
    const up = uptime();
    return Number.isFinite(up) && up > 0 ? up : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The start of process `pid` in clock ticks since boot, from
 * `/proc/<pid>/stat` — Linux only; `null` anywhere else, or when the file
 * cannot be read. Kept as the raw string: it is only ever compared with
 * another reading of the same field.
 */
export function readStartTicks(pid: number): string | null {
  if (process.platform !== "linux") return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // `pid (comm) state ppid …`: the command name may hold spaces and
  // parentheses, so fields are counted from its closing parenthesis.
  // `starttime` is field 22; the first field after `)` is field 3.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

let ownStartTicks: string | null | undefined;

/** This process's own `startTicks`, read once. */
function ownStart(): string | null {
  if (ownStartTicks === undefined) ownStartTicks = readStartTicks(process.pid);
  return ownStartTicks;
}

/** This process and host, right now. */
export function currentTurnOwnerProbe(): TurnOwnerProbe {
  return {
    pid: process.pid,
    hostUptime,
    isAlive: isProcessAlive,
    startTicksOf: (pid) =>
      pid === process.pid ? ownStart() : readStartTicks(pid),
  };
}

/** The mark `probe`'s process writes for a turn starting at `at`. */
export function turnOwnerFor(probe: TurnOwnerProbe, at: number): TurnOwner {
  const up = probe.hostUptime();
  const startTicks = probe.startTicksOf(probe.pid);
  return {
    pid: probe.pid,
    ...(up !== undefined ? { hostUptime: up } : {}),
    ...(startTicks !== null ? { startTicks } : {}),
    at,
  };
}

/** The stored form of a mark. */
export function serializeTurnOwner(owner: TurnOwner): string {
  return JSON.stringify({
    pid: owner.pid,
    ...(owner.hostUptime !== undefined ? { hostUptime: owner.hostUptime } : {}),
    ...(owner.startTicks !== undefined ? { startTicks: owner.startTicks } : {}),
    at: owner.at,
  });
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
  const { pid, hostUptime: up, startTicks, at } = value as Record<
    string,
    unknown
  >;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    ...(typeof up === "number" && Number.isFinite(up) && up > 0
      ? { hostUptime: up }
      : {}),
    ...(typeof startTicks === "string" && /^\d+$/.test(startTicks)
      ? { startTicks }
      : {}),
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
 * Once the pid is alive, only certain evidence counts: the host's uptime
 * has gone backwards since the mark (it rebooted), or the process now
 * holding the pid started at another moment than the one that wrote the
 * mark. Anything less leaves the row alone — cancelling a turn another
 * window is still running is the worse mistake, and a mark left behind
 * is cleared by a later boot or by the next turn on that session. Gone:
 *
 *  - no mark, or one that does not parse — a live status no turn claims
 *    (`beginTurn` never writes `running` without a mark, and `save` never
 *    writes a live status at all);
 *  - this process's pid (see above);
 *  - a pid with no process behind it;
 *  - a host that has rebooted since the mark;
 *  - a pid now held by a process that started at another moment.
 */
export function isTurnOwnerGone(
  raw: string | null,
  probe: TurnOwnerProbe,
): boolean {
  const owner = parseTurnOwner(raw);
  if (owner === null) return true;
  if (owner.pid === probe.pid) return true;
  if (!probe.isAlive(owner.pid)) return true;
  const up = probe.hostUptime();
  if (
    owner.hostUptime !== undefined &&
    up !== undefined &&
    up + UPTIME_SLACK_S < owner.hostUptime
  ) {
    return true;
  }
  if (owner.startTicks !== undefined) {
    const now = probe.startTicksOf(owner.pid);
    if (now !== null && now !== owner.startTicks) return true;
  }
  return false;
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
