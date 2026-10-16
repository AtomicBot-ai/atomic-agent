import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { posix, win32, join } from "node:path";

/**
 * The working folder the person picked (Settings › "Choose folder", the
 * `app:chooseWorkspace` handler in main.ts), remembered across launches.
 *
 * It lives in its own file, `<userData>/workspace.json`, and nowhere else:
 *
 * - not in prefs.json, whose writer keeps only the sidebar's `pinned` and
 *   `seen` and would drop any other key on the next pin;
 * - not in the agent's config.json, which the terminal shares with this
 *   window (ATO-416) and whose cwd is the shell's own.
 *
 * At launch `ATOMIC_AGENT_WORKSPACE` still wins (the smoke and drive
 * harnesses set it), then the saved folder, then the home folder. A saved
 * folder that is gone, or is no longer a folder, is ignored rather than
 * handed to the agent as a cwd it cannot enter.
 */

export function workspacePrefPath(userData: string): string {
  return join(userData, "workspace.json");
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The folder in a workspace.json body, or null for anything else. Does not touch the disk. */
export function parseWorkspacePref(text: string): string | null {
  try {
    const dir = (JSON.parse(text) as { dir?: unknown } | null)?.dir;
    if (typeof dir !== "string" || !dir) return null;
    return posix.isAbsolute(dir) || win32.isAbsolute(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The saved folder, or null when there is none, the file is unreadable or
 * corrupt, or the folder no longer exists as a directory. Never throws.
 * `exists` is injectable for tests only.
 */
export function readWorkspace(userData: string, exists: (dir: string) => boolean = isDirectory): string | null {
  let text: string;
  try {
    text = readFileSync(workspacePrefPath(userData), "utf8");
  } catch {
    return null;
  }
  const dir = parseWorkspacePref(text);
  return dir && exists(dir) ? dir : null;
}

/** Remember `dir`: written whole, via a temp file. Best effort, never throws. */
export function writeWorkspace(userData: string, dir: string): boolean {
  const path = workspacePrefPath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ dir }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The folder the agent starts in: the environment, else the saved choice, else home. */
export function startupWorkspace(env: string | undefined, saved: string | null, home: string): string {
  return env || saved || home;
}
