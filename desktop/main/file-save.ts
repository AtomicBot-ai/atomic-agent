/**
 * ATO-2347: Save from the preview panel's editor.
 *
 * The window hands main a path, the new text and the size and time of the
 * file as the panel read it. main writes only where the preview may read
 * (the same roots and path check as file-preview.ts: `~/…` or absolute, `..`
 * and links resolved, never a URL), only a file that is already there (Save
 * never creates one), only text (file-save-check.ts notEditable), and only
 * the very file the check passed (the open handle's dev/inode).
 *
 * When the file changed on disk since the panel read it, nothing is written
 * and the answer is `changed` with the file's new size and time; the window
 * then offers "Reload from disk" or "Overwrite", and Overwrite comes back
 * with `force`. A picture, PDF or Office file is refused even then.
 *
 * The file is written in place through the handle that was checked, so its
 * permissions, owner and links stay as they were; a byte order mark it began
 * with is kept.
 *
 * Pure but for the file system: no Electron import, so the unit suite loads it
 * from `out/main` and drives it against a throwaway "home".
 */

import { constants, open } from "node:fs/promises";

import { changedOnDisk, hasBom, notEditable, readStamp, type DiskStamp } from "./file-save-check.js";
import { imageTarget } from "./image-data-url.js";
import { pathFor, type Platform } from "./platform.js";

/** Four times what the panel reads of a text file: room to type, never a dump of anything. */
export const PREVIEW_SAVE_MAX_BYTES = 2 * 1024 * 1024;

export type FileSaveResult =
  | { ok: true; path: string; size: number; mtimeMs: number }
  | { ok: false; reason: "changed"; size: number; mtimeMs: number }
  | { ok: false; reason: "missing" | "outside" | "office" | "binary" | "too-large" | "bad-text" | "failed" };

/** Write `text` to `raw` for the preview's editor, unless the file changed since `stamp` (or `force`). */
export async function filePreviewSave(
  raw: unknown,
  text: unknown,
  stamp: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
  opts: { force?: boolean; maxBytes?: number } = {},
): Promise<FileSaveResult> {
  if (typeof text !== "string") return { ok: false, reason: "bad-text" };
  const max = opts.maxBytes ?? PREVIEW_SAVE_MAX_BYTES;
  if (Buffer.byteLength(text, "utf8") > max) return { ok: false, reason: "too-large" };
  const target = await imageTarget(raw, roots, home, platform);
  if (!target.ok) return { ok: false, reason: target.reason };
  const ext = pathFor(platform).extname(target.real).toLowerCase();
  // Read and write, never create; a link put in place of the file is not followed where the system allows it.
  const flags = constants.O_RDWR | (platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0));
  const fh = await open(target.real, flags).catch(() => null);
  if (!fh) return { ok: false, reason: "missing" };
  try {
    const st = await fh.stat();
    if (st.dev !== target.dev || st.ino !== target.ino) return { ok: false, reason: "outside" };
    if (!st.isFile()) return { ok: false, reason: "missing" };
    const head = Buffer.alloc(Math.min(8192, st.size));
    let filled = 0;
    while (filled < head.length) {
      const { bytesRead } = await fh.read(head, filled, head.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const why = notEditable(ext, head.subarray(0, filled));
    if (why) return { ok: false, reason: why };
    const now: DiskStamp = { size: st.size, mtimeMs: st.mtimeMs };
    if (!opts.force && changedOnDisk(readStamp(stamp), now)) return { ok: false, reason: "changed", ...now };
    const body = Buffer.from(text.replace(/^﻿/, ""), "utf8");
    const bytes = hasBom(head.subarray(0, filled)) ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, written, bytes.length - written, written);
      if (bytesWritten === 0) return { ok: false, reason: "failed" };
      written += bytesWritten;
    }
    await fh.truncate(bytes.length);
    await fh.sync().catch(() => undefined);
    const after = await fh.stat();
    return { ok: true, path: target.real, size: after.size, mtimeMs: after.mtimeMs };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
