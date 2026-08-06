import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Live-session registry for the managed llama-server daemon.
 *
 * The daemon is spawned detached so it survives the CLI process on
 * purpose (a warm model between sessions). The flip side is teardown:
 * when the last TUI session exits, `stopOnExit` wants to stop the
 * daemon — but only the *last* one may do it, or the first session to
 * exit kills the model out from under a second one still chatting
 * (a real bug before this module existed).
 *
 * Each TUI session drops a marker file `<dataDir>/sessions/<pid>` on
 * startup and removes it on clean exit. `hasOtherLiveSessions` scans
 * the directory, ignores the calling process and any marker whose pid
 * is dead (crashed sessions leave stale files behind; they are
 * reclaimed here, same pattern as `telegram-lockfile.ts`), and reports
 * whether anyone else is still running.
 *
 * Marker files are advisory, not locks: a race between "session A
 * exits" and "session B starts" at worst leaves the daemon running one
 * session longer or stops it a moment before B adopts it — B's
 * `autoStartIfReady` restarts it either way.
 */

const SESSIONS_DIR = "sessions";

function sessionsDir(dataDir: string): string {
  return join(dataDir, SESSIONS_DIR);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // `EPERM` (POSIX) / `EACCES` (Windows) both mean the process exists
    // but is owned by someone else — i.e. still alive. Only `ESRCH`
    // means dead.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

/**
 * Record this process as a live session. Returns a release function
 * for the clean-exit path; releasing twice is safe. A session that
 * dies without releasing is reclaimed by the next
 * `hasOtherLiveSessions` scan via the pid liveness check.
 */
export function registerSession(dataDir: string): () => void {
  const dir = sessionsDir(dataDir);
  const file = join(dir, String(process.pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, String(process.pid));
  } catch {
    // Best-effort: a session that could not register behaves like the
    // only session, which at worst stops the daemon while another
    // (equally unregistered) session is live — no worse than the
    // pre-registry behavior.
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone — release is idempotent.
    }
  };
}

/**
 * True when at least one *other* process holds a live session marker.
 * Stale markers (dead pid, unparsable name) are deleted as they are
 * encountered so the directory cannot accumulate garbage.
 */
export function hasOtherLiveSessions(dataDir: string): boolean {
  const dir = sessionsDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  let others = false;
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    const valid =
      Number.isFinite(pid) && pid > 0 && String(pid) === entry;
    if (valid && pid === process.pid) continue;
    if (valid && isAlive(pid)) {
      others = true;
      continue;
    }
    try {
      unlinkSync(join(dir, entry));
    } catch {
      // Someone else cleaned it first — fine.
    }
  }
  return others;
}
