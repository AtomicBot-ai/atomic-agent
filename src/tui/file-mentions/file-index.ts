/**
 * The file list the `@` palette searches: the working directory's files
 * as relative paths, bounded so a huge folder cannot stall the composer.
 *
 * A git checkout answers through `git ls-files` (tracked plus untracked,
 * minus everything .gitignore excludes), which is both fast and exactly
 * the set a person means by "my project". Anywhere else a breadth-first
 * walk stands in, skipping the usual dependency and build folders and
 * stopping at the file cap or the time budget, whichever comes first.
 *
 * One index lives per working directory for the session. A list is
 * reused while it is fresh and refreshed in the background after that,
 * so files created mid-session show up without a re-index on every key.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FileIndexLimits {
  /** Most paths kept. */
  maxFiles: number;
  /** Time budget for one listing, in milliseconds. */
  budgetMs: number;
  /** A list younger than this is reused as is. */
  freshMs: number;
}

export const DEFAULT_FILE_INDEX_LIMITS: FileIndexLimits = {
  maxFiles: 20_000,
  budgetMs: 200,
  freshMs: 15_000,
};

/** Folder names the walk never enters. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".idea",
  ".Trash", "Library", "vendor",
]);

export type ListFiles = (root: string, limits: FileIndexLimits) => Promise<string[]>;

/** `git ls-files`; rejects outside a repository or past the budget. */
export function listGitFiles(root: string, limits: FileIndexLimits): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      // Git gets more than the walk's budget: in a big checkout it is
      // still the faster and more correct of the two.
      { cwd: root, timeout: limits.budgetMs * 10, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return fail(error);
        const paths = String(stdout).split("\0").filter((p) => p.length > 0);
        done(paths.slice(0, limits.maxFiles));
      },
    );
  });
}

/** Breadth-first walk of `root`, bounded by the file cap and the clock. */
export async function walkFiles(
  root: string,
  limits: FileIndexLimits,
  now: () => number = Date.now,
): Promise<string[]> {
  const deadline = now() + limits.budgetMs;
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < limits.maxFiles && now() < deadline) {
    const dir = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir.length > 0 ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= limits.maxFiles) break;
      }
    }
  }
  return out;
}

async function listDefault(root: string, limits: FileIndexLimits): Promise<string[]> {
  try {
    return await listGitFiles(root, limits);
  } catch {
    return walkFiles(root, limits);
  }
}

export interface MentionFileIndex {
  /** The cached list for `root`, refreshed when stale. */
  list(root: string): Promise<readonly string[]>;
}

interface Entry {
  files: readonly string[];
  at: number;
  /** A listing has completed at least once. */
  loaded: boolean;
  pending: Promise<readonly string[]> | null;
}

export function createMentionFileIndex(
  options: { limits?: FileIndexLimits; listFiles?: ListFiles; now?: () => number } = {},
): MentionFileIndex {
  const limits = options.limits ?? DEFAULT_FILE_INDEX_LIMITS;
  const listFiles = options.listFiles ?? listDefault;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const refresh = (root: string, entry: Entry): Promise<readonly string[]> => {
    if (entry.pending) return entry.pending;
    entry.pending = listFiles(root, limits)
      .catch((): string[] => [])
      .then((listed) => {
        // A mention ends at whitespace, so a path with a space in it
        // could be picked but never sent; it is left out of the list.
        const files = listed.filter((p) => !/\s/.test(p));
        entry.files = files;
        entry.at = now();
        entry.loaded = true;
        entry.pending = null;
        return files;
      });
    return entry.pending;
  };

  return {
    list(root) {
      let entry = entries.get(root);
      if (!entry) {
        entry = { files: [], at: 0, loaded: false, pending: null };
        entries.set(root, entry);
        return refresh(root, entry);
      }
      // Stale but present: answer with what we have, refresh behind it.
      if (now() - entry.at >= limits.freshMs) void refresh(root, entry);
      return !entry.loaded && entry.pending ? entry.pending : Promise.resolve(entry.files);
    },
  };
}
