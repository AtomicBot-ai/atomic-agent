/**
 * ATO-416 — the desktop's seat in the agent's model-session registry.
 *
 * From this release the desktop and the terminal agent share one state
 * directory (state-dir.ts), so they share one managed data dir and ONE
 * llama-server. The agent already solves "who may stop the shared model" for
 * several terminal sessions: each drops a marker `<dataDir>/sessions/<pid>`
 * (the file holds the pid) on start, removes it on a clean exit, and the
 * session that exits stops the daemon only when no OTHER live marker is left
 * (src/local-llm/server/session-registry.ts, registerSession and
 * hasOtherLiveSessions; liveness is `process.kill(pid, 0)`, where EPERM or
 * EACCES still mean alive and only ESRCH means dead).
 *
 * The desktop joins that registry from the outside, because it cannot import
 * src/: this module is a port of those ~30 lines, same path, same file name,
 * same contents, same liveness rule, so either side reads the other's
 * markers exactly as its own.
 *   - On launch the desktop writes its marker under Electron main's pid, and
 *     removes it on exit (main.ts). A terminal session that exits while the
 *     desktop runs sees a live marker and leaves the model up.
 *   - Every `atag` child it spawns carries ATOMIC_AGENT_SESSION_PARENT_PID
 *     (state-dir.ts agentEnv), which the agent reads as "a marker with this
 *     pid is me", so a `models stop` the desktop runs does not count the
 *     desktop as another session.
 *   - Quitting the desktop (and the update's shutdown) skip `models stop`
 *     and the SIGKILL of leftovers when another live marker exists
 *     (backend-switch.ts stopDaemonForQuit): a terminal still chatting keeps
 *     its model.
 *
 * Markers are advisory, as the agent's header says: a race between one side
 * exiting and the other starting at worst leaves the daemon up one session
 * longer, or stops it a moment before the newcomer brings it back.
 *
 * ATO-418, pid reuse. A marker left by a crash or a forced logoff names a
 * pid the system may give to an unrelated process later, and the bare
 * liveness test then reads it as a session still using the model, so quit
 * keeps the model running for nobody. On macOS and Linux the desktop's own
 * marker therefore records its process start time on a second line
 * (process-start.ts), and a marker counts as live only when its pid is alive
 * AND that start still matches. The agent reads only the file NAME (its
 * session-registry.ts says the content is not read back), so the extra line
 * changes nothing there. A marker with no second line (the terminal's, or
 * the desktop's on Windows, where reading a start costs a PowerShell run)
 * keeps the old pid-only test.
 *
 * Nothing here imports state-dir.ts (which imports this module for the env
 * name), so the functions take the data dir as an argument.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pidFileOwnerAlive, pidFileText, processStartOf, recordedStart } from "./process-start.js";

/** The env var the agent reads to treat a marker with this pid as itself. */
export const SESSION_PARENT_PID_ENV = "ATOMIC_AGENT_SESSION_PARENT_PID";

/** session-registry.ts SESSIONS_DIR. */
const SESSIONS_DIR = "sessions";

export function modelSessionsDir(dataDir: string): string {
  return join(dataDir, SESSIONS_DIR);
}

/** session-registry.ts isAlive, verbatim in behaviour. */
export function modelSessionPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

/**
 * registerSession: write `<dataDir>/sessions/<pid>` holding the pid, and on
 * macOS and Linux the process start on a second line (ATO-418). Returns
 * the release for the clean-exit path; releasing twice is safe. Best effort,
 * as the agent's is: a desktop that could not register behaves like the
 * desktop before ATO-416, which is no worse than that.
 */
export function registerModelSession(
  dataDir: string,
  pid: number = process.pid,
  startOf: (pid: number) => string | null = processStartOf,
): () => void {
  const dir = modelSessionsDir(dataDir);
  const file = join(dir, String(pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, pidFileText(pid, startOf(pid)));
  } catch {
    // see above
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
}

/**
 * hasOtherLiveSessions, answering WHICH pids rather than whether: every live
 * marker but `selfPid`'s. Stale markers (a dead pid, a name that is not a
 * pid) are deleted as they are met, as the agent does, so neither side
 * accumulates garbage. A marker that recorded a process start is live only
 * while the process with that pid still has that start (ATO-418): a reused
 * pid is a stale marker. `alive` and `startOf` are parameters only so the
 * suite can drive the function without real processes.
 */
export function otherLiveModelSessions(
  dataDir: string,
  selfPid: number = process.pid,
  alive: (pid: number) => boolean = modelSessionPidAlive,
  startOf: (pid: number) => string | null = processStartOf,
): number[] {
  const dir = modelSessionsDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const others: number[] = [];
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    const valid = Number.isFinite(pid) && pid > 0 && String(pid) === entry;
    if (valid && pid === selfPid) continue;
    if (valid && pidFileOwnerAlive(pid, markerStart(join(dir, entry)), alive, startOf)) {
      others.push(pid);
      continue;
    }
    try {
      unlinkSync(join(dir, entry));
    } catch {
      // someone else cleaned it first
    }
  }
  return others;
}

/** The start a marker recorded; null for a bare-pid marker or one that cannot be read. */
function markerStart(file: string): string | null {
  try {
    return recordedStart(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The quit's decision, pure apart from the stale-marker sweep: stop the
 * shared model server only when nobody else holds a live marker. `others`
 * is said in the log line, so a model left running is never a mystery.
 */
export function quitMayStopModel(
  dataDir: string,
  selfPid: number = process.pid,
  alive: (pid: number) => boolean = modelSessionPidAlive,
  startOf: (pid: number) => string | null = processStartOf,
): { stop: boolean; others: number[] } {
  const others = otherLiveModelSessions(dataDir, selfPid, alive, startOf);
  return { stop: others.length === 0, others };
}
