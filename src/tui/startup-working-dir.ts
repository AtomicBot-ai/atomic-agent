import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Flags that already say which folder (or which saved chat) to open. */
const EXPLICIT_LOCATION_FLAGS = new Set(["--cwd", "--working-dir", "--session"]);

export interface StartupWorkingDirInput {
  /** The raw `tui` arguments, before parsing. */
  args: readonly string[];
  /** The folder the shell launched us in (`parseTuiArgs`'s default). */
  cwd: string;
  homeDir: string;
  /** `<stateDir>`; a session that ran in there is not a project to return to. */
  stateDir: string;
  /** Working dirs of the latest sessions, newest first. Read lazily. */
  recentDirs: () => readonly string[];
  /** Injected for tests; defaults to a `statSync` check. */
  isDirectory?: (path: string) => boolean;
}

export interface StartupWorkingDir {
  workingDir: string;
  /** `true` when `workingDir` came from the last session, not the shell. */
  restored: boolean;
}

/**
 * Which folder a launch opens in (ATO-5: a bare `atomic-agent` should
 * land in the agent where the operator left off).
 *
 * The folder the shell is in still wins whenever it means something: a
 * `cd project && atomic-agent` must open `project`, exactly as before.
 * Only a launch from the home directory — a fresh terminal window, a
 * double-clicked binary — carries no intent of its own, and there the
 * last session's folder is restored when it still exists. An explicit
 * `--cwd` / `--working-dir` / `--session` is never second-guessed, so
 * `--cwd .` (or `--cwd ~`) is the way to stay in home on purpose.
 */
export function resolveStartupWorkingDir(
  input: StartupWorkingDirInput,
): StartupWorkingDir {
  const cwd = resolve(input.cwd);
  const keep: StartupWorkingDir = { workingDir: cwd, restored: false };
  if (input.args.some((arg) => EXPLICIT_LOCATION_FLAGS.has(arg))) return keep;
  if (cwd !== resolve(input.homeDir)) return keep;
  const isDirectory = input.isDirectory ?? defaultIsDirectory;
  const stateDir = resolve(input.stateDir);
  let recent: readonly string[];
  try {
    recent = input.recentDirs();
  } catch {
    return keep;
  }
  for (const raw of recent) {
    const dir = resolve(raw);
    if (isInside(dir, stateDir)) continue;
    if (!isDirectory(dir)) continue;
    return dir === cwd ? keep : { workingDir: dir, restored: true };
  }
  return keep;
}

/** The one line the transcript shows when the folder was restored. */
export function formatRestoredWorkingDirNotice(
  workingDir: string,
  homeDir: string,
): string {
  const shown = isInside(workingDir, resolve(homeDir))
    ? `~/${relative(resolve(homeDir), workingDir)}`
    : workingDir;
  return `continuing in ${shown}, the folder of your last session (start with --cwd . to stay in the current folder)`;
}

function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
