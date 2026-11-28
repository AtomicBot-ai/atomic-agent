/**
 * Git folders in the working folders that are not named `.git`
 * (ATO-2471, review R2-1991.A), so the sandbox keeps them read-only the
 * way it keeps `.git`.
 *
 * The protected names (`sandbox-protected-paths.ts`) only match `.git`.
 * A repo can keep its git folder elsewhere: a `.git` file that says
 * `gitdir: ./.bare` (the bare-repo-plus-worktrees layout), a
 * `--separate-git-dir` inside the working folder, or a linked
 * worktree's `commondir`. A hook or config written there runs on the
 * user's next git command, outside the sandbox. Found here:
 * - the target of each `.git` file (the working folder's repo too, even
 *   when its top is above the working folder), and its `commondir`;
 * - every folder that holds `HEAD`, `objects/`, `refs/` and `config` (a
 *   bare repo), searched three levels deep like the protected names.
 * Only files are read; git is never run. Links are not followed into
 * (a `.git` link is resolved). The search costs a few `lstat` calls per
 * folder, at most 3000 folders per command.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { findRepo } from "./git-hooks-path.js";

/** Folders in a git folder that hold only git's data (no program names). */
export const GIT_DATA_DIRS: readonly string[] = [
  "objects", "refs", "logs", "lfs", "rr-cache", "reftable", "sequencer",
  "fsmonitor--daemon", "NOTES_MERGE_PARTIAL", "NOTES_MERGE_WORKTREE",
];

export interface GitDirScanLimits {
  /** Folder levels below each root searched (the root is level 0). */
  maxDepth?: number;
  /** Folders read in all, so a huge tree cannot stall a command. */
  maxDirs?: number;
}

/** A git folder, and the folders in it (and its worktrees and submodules) git writes data to. */
export interface GitDirEntry {
  dir: string;
  data: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".hg", ".svn"]);

function lstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const isDir = (path: string) => lstat(path)?.isDirectory() === true;
const isFile = (path: string) => lstat(path)?.isFile() === true;

/** A bare repo (or any git folder): `HEAD`, `objects/`, `refs/` and `config`. */
export function looksLikeGitDir(dir: string): boolean {
  return isFile(join(dir, "HEAD")) && isDir(join(dir, "objects")) && isDir(join(dir, "refs")) && isFile(join(dir, "config"));
}

/** The folder a `.git` file points at (`gitdir: <path>`), or null. */
export function dotGitFileTarget(file: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(file) ?? "");
  return m?.[1] === undefined ? null : resolve(dirname(file), m[1]);
}

/** A git folder and the common folder its `commondir` names, if any. */
function withCommon(gitDir: string): string[] {
  const common = readText(join(gitDir, "commondir"))?.trim();
  return common === undefined || common === "" ? [gitDir] : [gitDir, resolve(gitDir, common)];
}

/** True when a path is a `.git` or inside one (the protected names cover it). */
export function inDotGit(path: string): boolean {
  return path.split("/").includes(".git");
}

/** The git folders in or reached from the working folders, as resolved paths. */
export function findGitDirs(roots: readonly string[], limits: GitDirScanLimits = {}): string[] {
  const maxDepth = limits.maxDepth ?? 3;
  let budget = limits.maxDirs ?? 3000;
  const out: string[] = [];
  for (const root of roots) {
    const repo = findRepo(root);
    if (repo !== null) out.push(...withCommon(repo.gitDir));
  }
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    budget -= 1;
    if (looksLikeGitDir(dir)) {
      out.push(...withCommon(dir));
      continue;
    }
    for (const name of names(dir)) {
      const path = join(dir, name);
      const st = lstat(path);
      if (st === null) continue;
      if (name === ".git") {
        // A `.git` file names its folder; a `.git` link resolves to it.
        const target = st.isFile() ? dotGitFileTarget(path) : st.isSymbolicLink() ? real(path) : null;
        if (target !== null) out.push(...withCommon(target));
        continue;
      }
      if (st.isDirectory() && !SKIP_DIRS.has(name) && depth < maxDepth) {
        queue.push({ dir: path, depth: depth + 1 });
      }
    }
  }
  return [...new Set(out.filter((p) => isDir(p)).map(real))];
}

/**
 * The data folders of a git folder, its linked worktrees' and its
 * submodules' (one level of `modules/`), for the macOS rule: these stay
 * writable so git still commits there; the rest of the folder does not.
 */
export function gitDataDirs(gitDir: string): string[] {
  const bases = [gitDir];
  for (const sub of ["worktrees", "modules"]) {
    for (const name of names(join(gitDir, sub))) {
      const path = join(gitDir, sub, name);
      if (isDir(path) && isFile(join(path, "HEAD"))) bases.push(path);
    }
  }
  return bases.flatMap((base) => GIT_DATA_DIRS.map((name) => join(base, name)));
}
