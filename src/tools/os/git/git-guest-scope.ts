import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { runCommand } from "../../../sandbox/command-runner.js";

/**
 * Where git may look for a channel guest's repository (ATO-2221).
 *
 * Git walks up from its working folder until it finds a `.git`, so a
 * guest's `os.git.show` in a working directory that sits inside a bigger
 * repository (the owner's home folder may be one) reads that repository:
 * `HEAD:<path>` then prints tracked files outside the working directory.
 * For a guest call `runGit` therefore:
 *
 *  - sets `GIT_CEILING_DIRECTORIES` to the working directory's parent, so
 *    git never climbs above the working directory, and drops `GIT_DIR` /
 *    `GIT_WORK_TREE`, which would skip the search altogether;
 *  - asks git for the repository's top folder and refuses the call when
 *    it is not inside the working directory.
 *
 * Owner calls are untouched. Precedent: Codex and Claude Code confine
 * sandboxed sessions to the workspace folder, not to whatever repository
 * happens to contain it.
 */

function realDir(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The env a guest's git runs with: no climbing above the working directory. */
export function guestGitEnv(env: NodeJS.ProcessEnv, workingDir: string): NodeJS.ProcessEnv {
  const scoped: NodeJS.ProcessEnv = {
    ...env,
    GIT_CEILING_DIRECTORIES: dirname(realDir(workingDir)),
  };
  delete scoped.GIT_DIR;
  delete scoped.GIT_WORK_TREE;
  delete scoped.GIT_COMMON_DIR;
  return scoped;
}

/** Throws unless the repository at `repoRoot` lies inside `workingDir`. */
export async function assertGuestRepoInside(
  repoRoot: string,
  workingDir: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    env,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    signal,
  });
  const top = result.stdout.trim();
  if (result.exitCode !== 0 || top.length === 0) {
    throw new Error(
      `os.git: refused for a guest: ${repoRoot} is not in a repository inside the working directory (${workingDir})`,
    );
  }
  if (!isWithin(realDir(workingDir), realDir(top))) {
    throw new Error(
      `os.git: refused for a guest: the repository root ${top} is outside the working directory (${workingDir})`,
    );
  }
}
