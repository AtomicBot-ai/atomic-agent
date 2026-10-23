/**
 * ATO-418 — when a process started, so a pid file can tell a live owner from
 * a stranger that was later given the same pid.
 *
 * A pid alone names a process only while it lives. After a crash, a forced
 * logoff or a kill that left no exit handler running, the pid in a marker
 * (model-sessions.ts) or in the merge lock (state-migrate.ts) can be handed
 * to an unrelated process, and `process.kill(pid, 0)` then says "alive". The
 * pid together with the kernel's start time names exactly one process for as
 * long as the host is up.
 *
 * A port of `processStartOf` in src/session/turn-owner.ts (the desktop cannot
 * import src/), same readings, same strings, so the two sides could compare
 * them should they ever need to:
 *   - Linux: `starttime` from `/proc/<pid>/stat` (field 22, clock ticks since
 *     boot), one file read;
 *   - macOS: `ps -o lstart=`, printed in UTC with the C locale so a time-zone
 *     change does not alter it, one short `ps`;
 *   - anywhere else (Windows): `null`. Asking there costs a PowerShell start
 *     of several hundred milliseconds; callers fall back to the pid alone,
 *     which is what they did before.
 *
 * `null` also means "could not read", which callers must treat as unknown,
 * never as gone.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function processStartOf(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === "linux") return linuxStartTicks(pid);
  if (platform === "darwin") return darwinStart(pid);
  return null;
}

function linuxStartTicks(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // `pid (comm) state ppid ...`: the command name may hold spaces and
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
      // Nothing of this process's environment (keys included) goes to `ps`.
      env: { LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? `lstart:${out.replace(/\s+/g, " ")}` : null;
  } catch {
    return null;
  }
}

/**
 * The text of a pid file that also records the start: the pid on the first
 * line (what every older reader parses), the start on the second when it is
 * known. With no start (Windows) it is the bare pid, as before.
 */
export function pidFileText(pid: number, start: string | null): string {
  return start ? `${pid}\n${start}\n` : String(pid);
}

/** The start a pid file recorded, or null for a bare-pid file. */
export function recordedStart(text: string): string | null {
  const second = text.split(/\r?\n/)[1]?.trim();
  return second ? second : null;
}

/**
 * Whether the process a pid file names is still the one that wrote it: the
 * pid is alive AND, when the file recorded a start and the start can be read
 * now, the two agree. A file with no start, or a start that cannot be read
 * now, keeps the old pid-only answer.
 */
export function pidFileOwnerAlive(
  pid: number,
  start: string | null,
  alive: (pid: number) => boolean,
  startOf: (pid: number) => string | null = processStartOf,
): boolean {
  if (!alive(pid)) return false;
  if (!start) return true;
  const now = startOf(pid);
  return now === null || now === start;
}
