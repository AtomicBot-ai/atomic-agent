import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
 *
 * Shared state dir with the desktop app (ATO-416). The desktop and the
 * terminal agent use one `~/.atomic-agent`, so the desktop takes part in
 * this registry as a session of its own. The format it mirrors:
 *
 *  - directory: `<localModelsDataDir>/sessions/` — `<stateDir>/models/
 *    sessions/` unless `localModels.managed.dataDirOverride` is set
 *    (`~/.atomic-agent/models/sessions/` by default);
 *  - one file per live process, named by its pid in canonical decimal
 *    (no sign, no leading zeros, no extension), e.g. `.../sessions/4242`;
 *  - the content is the same pid as text; it is not read back — only the
 *    name counts. Create it on start, delete it on clean exit; a marker
 *    whose pid is dead is deleted by the next scan.
 *
 * The desktop runs every `atag` it spawns with
 * `ATOMIC_AGENT_SESSION_PARENT_PID=<desktop pid>`. That child is part of
 * the desktop's session, not another app: the desktop's marker counts as
 * SELF for it, exactly like the child's own pid. Without that, every
 * `atag models …` the desktop runs would see the desktop as "another
 * session still using the model" and refuse to stop or update the
 * daemon the desktop itself asked it to manage.
 */

const SESSIONS_DIR = "sessions";

/** Env var naming the pid of the app whose session this process belongs to. */
export const SESSION_PARENT_PID_ENV = "ATOMIC_AGENT_SESSION_PARENT_PID";

/**
 * The session parent pid from `env` (ATO-416), or `null` when it is
 * unset or not a positive integer in canonical decimal. A malformed
 * value is ignored rather than trusted: it must never turn a real other
 * session into "self".
 */
export function sessionParentPid(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[SESSION_PARENT_PID_ENV]?.trim();
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 && String(pid) === raw
    ? pid
    : null;
}

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
 *
 * "Other" excludes this process and, when `env` names one, the session
 * parent (`ATOMIC_AGENT_SESSION_PARENT_PID`, see the module comment): an
 * `atag` the desktop spawned is the desktop's own session. A dead
 * parent's marker is still reclaimed like any stale one.
 */
export function hasOtherLiveSessions(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dir = sessionsDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  const parentPid = sessionParentPid(env);
  let others = false;
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    const valid = Number.isFinite(pid) && pid > 0 && String(pid) === entry;
    if (valid && pid === process.pid) continue;
    if (valid && pid === parentPid && isAlive(pid)) continue;
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
