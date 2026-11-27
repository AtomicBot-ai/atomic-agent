/**
 * ATO-2347: the two questions the preview's Save asks before it writes.
 *
 * 1. Did the file change on disk since the panel read it? The panel keeps the
 *    size and modification time main read with the text (file-preview.ts);
 *    Save sends them back, and main compares them with the file as it is now.
 *    Either one different means someone else (often the agent) wrote it, and
 *    the window asks "Reload from disk" or "Overwrite", as VS Code does with
 *    "The file is newer on disk" and Kilo Desktop's files tab does.
 * 2. Is it a file the panel may write at all? Only text: never a picture, a
 *    PDF, a Word, PowerPoint or Excel file, or anything with NUL bytes in its
 *    head, whatever its name says.
 *
 * Pure: no file system, no Electron, so the unit suite loads it from `out/main`.
 */

import { sniffImageMime } from "./image-data-url.js";
import { looksZip, officeTypeFor } from "./office-preview.js";

export type DiskStamp = { size: number; mtimeMs: number };

/** A stamp the window sent, or null when it is not one (a missing stamp never passes as "unchanged"). */
export function readStamp(raw: unknown): DiskStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const { size, mtimeMs } = raw as Record<string, unknown>;
  if (typeof size !== "number" || typeof mtimeMs !== "number") return null;
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || size < 0) return null;
  return { size, mtimeMs };
}

/** The file on disk is not the one the panel read: another size or another time. */
export function changedOnDisk(read: DiskStamp | null, now: DiskStamp): boolean {
  if (!read) return true;
  return read.size !== now.size || read.mtimeMs !== now.mtimeMs;
}

/** Why the panel may not write this file, or null when it may: decided by its first bytes and its extension. */
export function notEditable(ext: string, head: Uint8Array): "office" | "binary" | null {
  if (officeTypeFor(ext)) return "office";
  if (sniffImageMime(head.subarray(0, 16))) return "binary";
  if (looksZip(head)) return "binary";
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) return "binary";
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return "binary";
  return null;
}

/** A UTF-8 byte order mark at the start of the file: kept when the file is written again. */
export function hasBom(head: Uint8Array): boolean {
  return head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
}
