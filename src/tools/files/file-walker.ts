import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_IGNORE } from "../os/fs/fs-glob.js";
import { isIndexablePath } from "./file-text.js";

/**
 * Walk one added folder for the files the index reads. Skips what
 * `os.fs.glob` skips by default (`node_modules`, `.git`, build output,
 * caches, `Library`, virtualenvs, …), every hidden file and folder, and
 * symlinks (no loops, nothing outside the folder). Files over `maxBytes`
 * are reported with `tooLarge` so they count as skipped rather than
 * vanish. Stops after `maxFiles` files.
 */
export interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
  tooLarge: boolean;
}

export interface WalkOptions {
  maxBytes: number;
  maxFiles: number;
  signal?: AbortSignal;
}

/** Folder names `os.fs.glob` ignores (`**\/<name>/**`). */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set(
  DEFAULT_IGNORE.map((pattern) => pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")).filter(
    (name) => !name.includes("/") && !name.includes("*"),
  ),
);

export async function walkFolder(root: string, options: WalkOptions): Promise<WalkedFile[]> {
  const found: WalkedFile[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < options.maxFiles) {
    if (options.signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable (permissions) or gone since: the rest of the walk goes on.
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile() || !isIndexablePath(path)) continue;
      try {
        const info = await stat(path);
        found.push({ path, mtimeMs: info.mtimeMs, size: info.size, tooLarge: info.size > options.maxBytes });
      } catch {
        continue;
      }
      if (found.length >= options.maxFiles) break;
    }
  }
  return found;
}
