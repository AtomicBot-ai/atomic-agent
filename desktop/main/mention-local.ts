/**
 * ATO-2241: the two local kinds beyond a whole file, under the same guard
 * as `@file` (file-mentions.ts): the path as written and its real path
 * after symlinks must both be inside the chat folder.
 *
 *   @src/a.ts:10-40   those lines, numbered like `cat -n`
 *   @src/             the folder's file list (git ls-files through the
 *                     guarded runGit of mention-git.ts when it is a
 *                     checkout, else the bounded walk), capped
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  BINARY_SNIFF_BYTES,
  inside,
  readHead,
  resolveMentionedFile,
  walkFiles,
  type FileIndexLimits,
} from "./file-mentions.js";
import { lsFilesArgs, runGit, type RunGit } from "./mention-git.js";

/** Most of a file scanned for a line range. */
export const RANGE_SCAN_BYTES = 2 * 1024 * 1024;
/** Most paths listed for one folder. */
export const FOLDER_MAX_FILES = 200;

const FOLDER_LIMITS: FileIndexLimits = { maxFiles: FOLDER_MAX_FILES, budgetMs: 200, freshMs: 0 };

/** Raised for a mention that is understood but not inlined: the reason goes in the block. */
export class LocalSkip extends Error {}

/** Lines `start`..`end` (1-based) of the file `path` names inside `root`, numbered; `null` when it is no file there. */
export function readLineRange(root: string, path: string, start: number, end: number): string | null {
  const real = resolveMentionedFile(root, path);
  if (!real) return null;
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
  for (let n = start; n <= last; n++) out.push(`${String(n).padStart(width, " ")}\t${lines[n - 1] ?? ""}`);
  return `${out.join("\n")}\n`;
}

/** The real path of `token` when it is a folder inside `root` (not `root` itself), else `null`. */
export function resolveMentionedDir(root: string, token: string): string | null {
  const t = token.replace(/\/+$/, "");
  if (t.length === 0 || isAbsolute(t)) return null;
  const candidate = resolve(root, t);
  if (!inside(root, candidate)) return null;
  try {
    const real = realpathSync(candidate);
    if (!inside(root, real)) return null;
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export type ListFolder = (dir: string) => Promise<string[]>;

export function createListFolder(git: RunGit = runGit): ListFolder {
  return async (dir) => {
    try {
      const out = await git(dir, lsFilesArgs());
      const paths = out.text.split("\0").filter((p) => p.length > 0);
      // A cut answer ends in half a path.
      if (out.cut) paths.pop();
      return paths.slice(0, FOLDER_MAX_FILES);
    } catch {
      return walkFiles(dir, FOLDER_LIMITS);
    }
  };
}

export const listFolder: ListFolder = createListFolder();

/** The listing as the block carries it: one path per line, relative to the chat folder. */
export function folderListing(shown: string, paths: readonly string[]): string {
  const base = shown.replace(/\/+$/, "");
  const kept = [...paths].sort().slice(0, FOLDER_MAX_FILES);
  if (kept.length === 0) return "(no files)\n";
  const lines = kept.map((p) => `${base}/${p}`);
  if (paths.length >= FOLDER_MAX_FILES) lines.push(`[listing stops at ${FOLDER_MAX_FILES} files]`);
  return `${lines.join("\n")}\n`;
}
