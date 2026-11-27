/**
 * The two local kinds beyond a whole file (ATO-2241, shared since
 * ATO-2472), under the same guard as `@file` (expand-file-mentions.ts):
 * the path as written and its real path after symlinks must both be
 * inside the working folder, and the agent's own key files are refused.
 *
 *   @src/a.ts:10-40   those lines, numbered like `cat -n`
 *   @src/             the folder's file list (git ls-files through the
 *                     guarded runGit of mention-git.ts when it is a
 *                     checkout, else a bounded walk), capped
 */

import type { Dirent } from "node:fs";
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { inside, readHead, resolveMentionedFile, type IsProtectedPath } from "./expand-file-mentions.js";
import { lsFilesArgs, runGit, type RunGit } from "./mention-git.js";

/** Most of a file scanned for a line range. */
export const RANGE_SCAN_BYTES = 2 * 1024 * 1024;
/** Most paths listed for one folder. */
export const FOLDER_MAX_FILES = 200;
/** Time budget of the walk outside a checkout. */
export const FOLDER_WALK_MS = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Folder names the walk never enters. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target",
  "coverage", ".next", ".turbo", ".cache", ".venv", "venv", "__pycache__",
]);

/** Raised for a mention that is understood but not inlined: the reason goes in the block. */
export class LocalSkip extends Error {}

/**
 * Lines `start`..`end` (1-based) of the file `path` names inside `root`,
 * numbered; `null` when it is no file there.
 */
export function readLineRange(
  root: string,
  path: string,
  start: number,
  end: number,
  isProtected: IsProtectedPath = () => false,
): string | null {
  const real = resolveMentionedFile(root, path);
  if (!real) return null;
  if (isProtected(real)) throw new LocalSkip("the agent's own settings file is never inlined");
  const size = statSync(real).size;
  const head = readHead(real, Math.min(size, RANGE_SCAN_BYTES));
  if (head.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new LocalSkip("binary file");
  const lines = head.toString("utf8").split("\n");
  // A last line cut by the scan limit is not a whole line.
  if (head.length < size) lines.pop();
  else if (lines[lines.length - 1] === "") lines.pop();
  if (start > lines.length) {
    throw new LocalSkip(head.length < size
      ? `line ${start} is past the first ${lines.length} lines read`
      : `the file has ${lines.length} lines`);
  }
  const last = Math.min(end, lines.length);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = start; n <= last; n++) out.push(`${String(n).padStart(width, " ")}\t${(lines[n - 1] ?? "").replace(/\r$/, "")}`);
  return `${out.join("\n")}\n`;
}

/** The real path of `token` when it is a folder inside `root` (not `root` itself), else `null`. */
export function resolveMentionedDir(root: string, token: string): string | null {
  const t = token.replace(/[/\\]+$/, "");
  if (t.length === 0 || isAbsolute(t)) return null;
  const candidate = resolve(root, t);
  if (!inside(root, candidate)) return null;
  try {
    const real = realpathSync.native(candidate);
    if (!inside(root, real)) return null;
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export type ListFolder = (dir: string) => Promise<string[]>;

/** Breadth-first walk of `dir`, bounded by the file cap and the clock. */
export async function walkFolder(dir: string, now: () => number = Date.now): Promise<string[]> {
  const deadline = now() + FOLDER_WALK_MS;
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < FOLDER_MAX_FILES && now() < deadline) {
    const rel = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        out.push(path);
        if (out.length >= FOLDER_MAX_FILES) break;
      }
    }
  }
  return out;
}

export function createListFolder(git: RunGit = runGit): ListFolder {
  return async (dir) => {
    try {
      const out = await git(dir, lsFilesArgs());
      const paths = out.text.split("\0").filter((p) => p.length > 0);
      // A cut answer ends in half a path.
      if (out.cut) paths.pop();
      return paths.slice(0, FOLDER_MAX_FILES);
    } catch {
      return walkFolder(dir);
    }
  };
}

export const listFolder: ListFolder = createListFolder();

/** The listing as the block carries it: one path per line, relative to the working folder. */
export function folderListing(shown: string, paths: readonly string[]): string {
  const base = shown.replace(/[/\\]+$/, "");
  const kept = [...paths].sort().slice(0, FOLDER_MAX_FILES);
  if (kept.length === 0) return "(no files)\n";
  const lines = kept.map((p) => `${base}/${p}`);
  if (paths.length >= FOLDER_MAX_FILES) lines.push(`[listing stops at ${FOLDER_MAX_FILES} files]`);
  return `${lines.join("\n")}\n`;
}
