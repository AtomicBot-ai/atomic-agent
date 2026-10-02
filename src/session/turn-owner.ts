import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
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
   * What the pid is a pid of: the platform, and on Linux the pid
   * namespace (`/proc/self/ns/pid`). A container sharing the state dir
   * with its host — or with another container — numbers its processes
   * on its own; a mark from another namespace says nothing about the pid
   * of the same number here, so it is never judged from here. The
   * hostname is deliberately not part of it: on a Mac it follows the
   * network, and a mark that looked foreign after a network change would
   * never be cleared.
   */
  readonly host?: string;
  /**
   * The database file the mark was written into (its real path). A mark
   * found in another file came with a copy — the desktop's "bring your
   * terminal setup over" import, a restored backup — and whatever turn it
   * names runs on the original, never on the copy.
   */
  readonly db?: string;
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
   * When the owning process started, as the kernel recorded it
   * (`processStartOf`). With the pid it names exactly one process for as
   * long as the host is up, so a pid since reused by another process is
   * caught. Absent where it cannot be read cheaply (Windows).
   */
  readonly processStart?: string;
  /** When the turn started, ms since the epoch. For diagnostics. */
  readonly at: number;
}

/**
 * This process and host: what a mark records about the turn's owner, and
 * what `isTurnOwnerGone` compares a mark against. Functions, not values,
 * where the answer moves, so each mark and each sweep reads the host as
 * it is at that moment.
 */
export interface TurnOwnerProbe {
  readonly pid: number;
  /** `TurnOwner.host` for this process; `undefined` when unknown. */
  readonly host: string | undefined;
  /** The host's uptime now, in seconds; `undefined` when unknown. */
  readonly hostUptime: () => number | undefined;
  readonly isAlive: (pid: number) => boolean;
  /** `TurnOwner.processStart` of process `pid`, or `null` when it cannot be read. */
  readonly processStartOf: (pid: number) => string | null;
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

/** `TurnOwner.host` for this process (see there). */
export function hostIdentity(): string {
  if (process.platform !== "linux") return process.platform;
  try {
    return `linux:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return "linux";
  }
}

/**
 * The start of process `pid` as the kernel recorded it, as an opaque
 * string only ever compared with another reading on the same host:
 *
 *  - Linux: `starttime` from `/proc/<pid>/stat`, in clock ticks since
 *    boot — a file read;
 *  - macOS: `ps -o lstart=`, the start the kernel stored when the process
 *    was created, printed in UTC with the C locale so neither a time-zone
 *    change nor the wall clock moving since alters it — one short `ps`;
 *  - anywhere else (Windows): `null`. Asking costs a PowerShell start of
 *    several hundred milliseconds, too much for the turn path.
 *
 * `null` too when the process cannot be read, which callers must treat
 * as "unknown", never as "gone".
 */
export function processStartOf(pid: number): string | null {
  if (process.platform === "linux") return linuxStartTicks(pid);
  if (process.platform === "darwin") return darwinStart(pid);
  return null;
}

function linuxStartTicks(pid: number): string | null {
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
  const start = stat.slice(close + 1).trim().split(/\s+/)[19];
  return start !== undefined && /^\d+$/.test(start) ? `ticks:${start}` : null;
}

function darwinStart(pid: number): string | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      // Nothing of this process's environment (keys included) goes to
      // `ps`; it needs only the locale and the zone to print in.
      env: { LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? `lstart:${out.replace(/\s+/g, " ")}` : null;
  } catch {
    return null;
  }
}

let ownStart: string | null | undefined;

/** This process's own start, read once. */
function ownProcessStart(): string | null {
  if (ownStart === undefined) ownStart = processStartOf(process.pid);
  return ownStart;
}

/** This process and host, right now. */
export function currentTurnOwnerProbe(): TurnOwnerProbe {
  return {
    pid: process.pid,
    host: hostIdentity(),
    hostUptime,
    isAlive: isProcessAlive,
    processStartOf: (pid) =>
      pid === process.pid ? ownProcessStart() : processStartOf(pid),
  };
}

/**
 * The mark `probe`'s process writes into the database at `db` for a turn
 * starting at `at`.
 */
export function turnOwnerFor(
  probe: TurnOwnerProbe,
  at: number,
  db?: string,
): TurnOwner {
  const up = probe.hostUptime();
  const start = probe.processStartOf(probe.pid);
  return {
    pid: probe.pid,
    ...(probe.host !== undefined ? { host: probe.host } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(up !== undefined ? { hostUptime: up } : {}),
    ...(start !== null ? { processStart: start } : {}),
    at,
  };
}

/** The stored form of a mark. */
export function serializeTurnOwner(owner: TurnOwner): string {
  return JSON.stringify({
    pid: owner.pid,
    ...(owner.host !== undefined ? { host: owner.host } : {}),
    ...(owner.db !== undefined ? { db: owner.db } : {}),
    ...(owner.hostUptime !== undefined ? { hostUptime: owner.hostUptime } : {}),
    ...(owner.processStart !== undefined
      ? { processStart: owner.processStart }
      : {}),
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
  const fields = value as Record<string, unknown>;
  const { pid, host, db, processStart, at } = fields;
  const up = fields.hostUptime;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0;
  return {
    pid,
    ...(text(host) ? { host } : {}),
    ...(text(db) ? { db } : {}),
    ...(typeof up === "number" && Number.isFinite(up) && up > 0
      ? { hostUptime: up }
      : {}),
    ...(text(processStart) ? { processStart } : {}),
    at: typeof at === "number" && Number.isFinite(at) ? at : 0,
  };
}

/**
 * Whether the process a `running` row names can no longer be running
 * that turn — so the row is a turn that will never write its end.
 * `db` is the real path of the database the row was read from.
 *
 * Meant for the boot sweep, before this process has started a turn of
 * its own: a mark carrying this process's pid then belongs to an earlier
 * process that had the same number (or to an earlier runtime in this one
 * that never got to release it), never to a live turn.
 *
 * A mark from another pid namespace is never judged at all (`host`).
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
 *  - a mark written into another database file — this row is a copy;
 *  - this process's pid (see above);
 *  - a pid with no process behind it;
 *  - a host that has rebooted since the mark;
 *  - a pid now held by a process that started at another moment.
 */
export function isTurnOwnerGone(
  raw: string | null,
  probe: TurnOwnerProbe,
  db?: string,
): boolean {
  const owner = parseTurnOwner(raw);
  if (owner === null) return true;
  if (
    owner.host !== undefined &&
    probe.host !== undefined &&
    owner.host !== probe.host
  ) {
    return false;
  }
  if (owner.db !== undefined && db !== undefined && owner.db !== db) {
    return true;
  }
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
  if (owner.processStart !== undefined) {
    const now = probe.processStartOf(owner.pid);
    if (now !== null && now !== owner.processStart) return true;
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
