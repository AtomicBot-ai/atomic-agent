/**
 * ATO-408: an image file on disk, handed to the window as a `data:` URL.
 *
 * The window's CSP is `img-src 'self' data:`, so a picture the agent made (a
 * reply attachment) or one the person attached can only be shown once main has
 * read it and inlined it. The path comes from the agent's reply or from the
 * window, so it is checked the way a reply chip is (reply-paths.ts): written
 * `~/…` or absolute, never a URL, `..` and symlinks resolved, and only inside
 * the allowed roots (the home folder, the agent's state folder and the system's
 * temporary folders, where models often write). The file is opened once, the
 * opened handle is checked to be the very file the path check passed (a link
 * swapped in between is refused), and it is used only when it is a regular file
 * under the size cap whose first bytes say PNG, JPEG, WebP or GIF — never by its
 * name, and never SVG, which can carry script. Save As… and Reveal go through
 * the same check, so they cannot be pointed at a file that is not a picture.
 *
 * Shared contract (ATO-404–406 use it for the person's own attachments):
 *   BR.imageDataUrl(path) → {ok:true, dataUrl, mime, size, mtimeMs}
 *                         | {ok:false, reason:'missing'|'too-large'|'outside'}
 * `missing` covers everything that leaves no picture to show: not there, not a
 * file, not a path, or not one of the four image types. `size` and `mtimeMs`
 * say which version of the file the picture is, so a cache can tell when the
 * file was overwritten.
 *
 * Pure but for the file system reads: no Electron import, so the unit suite
 * loads it from `out/main` and drives it against a throwaway "home".
 */

import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";

import { expandHome, isAbsoluteOn, isUnder, pathFor, type Platform } from "./platform.js";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ImageDataUrlResult =
  | { ok: true; dataUrl: string; mime: ImageMime; size: number; mtimeMs: number }
  | { ok: false; reason: "missing" | "too-large" | "outside" };

/** Bigger than any picture worth showing inline; the data URL is a third larger again. */
export const IMAGE_DATA_URL_MAX_BYTES = 15 * 1024 * 1024;

/** The image type its first bytes say, or null for anything else. */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  return null;
}

/** The roots pictures are read from: home, the agent's state folder, the temporary folders. */
export function imageRootsFor(platform: Platform, home: string, stateDir: string, tmp: string): string[] {
  const roots = [home, stateDir, tmp];
  if (platform !== "win32") roots.push("/tmp", "/var/tmp");
  return roots.filter((r) => typeof r === "string" && r.length > 0);
}

/** Where a path stands against the roots, before anything is opened. */
async function imageTarget(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
): Promise<{ ok: true; real: string; dev: number; ino: number } | { ok: false; reason: "missing" | "outside" }> {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || /[\0\r\n]/.test(raw)) return { ok: false, reason: "missing" };
  // A URL, a file: URL, or a Windows network path is never a file to read from here.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) || /^file:/i.test(raw)) return { ok: false, reason: "outside" };
  if (platform === "win32" && /^[\\/]{2}/.test(raw)) return { ok: false, reason: "outside" };
  const expanded = raw === "~" ? home : expandHome(platform, raw, home);
  if (!isAbsoluteOn(platform, expanded)) return { ok: false, reason: "missing" };
  const P = pathFor(platform);
  const lexical = P.resolve(expanded);
  const given = roots.filter((r) => typeof r === "string" && r.length > 0).map((r) => P.resolve(r));
  const realRoots: string[] = [];
  for (const root of given) {
    const r = await realpath(root).catch(() => null);
    if (r) realRoots.push(r);
  }
  const inside = (p: string, list: readonly string[]) => list.some((root) => isUnder(platform, root, p));
  // Outside every root as written: refused without touching the disk.
  if (!inside(lexical, given) && !inside(lexical, realRoots)) return { ok: false, reason: "outside" };
  const real = await realpath(lexical).catch(() => null);
  if (!real) return { ok: false, reason: "missing" };
  // A link inside a root that leads out of it is outside it.
  if (!inside(real, realRoots)) return { ok: false, reason: "outside" };
  const st = await stat(real).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, reason: "missing" };
  return { ok: true, real, dev: st.dev, ino: st.ino };
}

export type OpenedImage = {
  real: string;
  mime: ImageMime;
  size: number;
  mtimeMs: number;
  /** The open file: the caller reads it from here and closes it. */
  fh: FileHandle;
};

/**
 * The picture at `raw`, opened and checked: inside the roots, the same file
 * the check passed (dev/inode of the open handle), a regular file under the
 * cap, and an image by its first bytes. The caller closes `fh`.
 */
export async function openImage(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
  maxBytes: number = IMAGE_DATA_URL_MAX_BYTES,
): Promise<{ ok: true; image: OpenedImage } | { ok: false; reason: "missing" | "too-large" | "outside" }> {
  const target = await imageTarget(raw, roots, home, platform);
  if (!target.ok) return target;
  const fh = await open(target.real, "r").catch(() => null);
  if (!fh) return { ok: false, reason: "missing" };
  let keep = false;
  try {
    const st = await fh.stat();
    // Swapped for another file (a link put in its place) since it was checked.
    if (st.dev !== target.dev || st.ino !== target.ino) return { ok: false, reason: "outside" };
    if (!st.isFile()) return { ok: false, reason: "missing" };
    if (st.size > maxBytes) return { ok: false, reason: "too-large" };
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, 16, 0);
    const mime = sniffImageMime(head.subarray(0, bytesRead));
    if (!mime) return { ok: false, reason: "missing" };
    keep = true;
    return { ok: true, image: { real: target.real, mime, size: st.size, mtimeMs: st.mtimeMs, fh } };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    if (!keep) await fh.close().catch(() => undefined);
  }
}

/** The whole of an opened picture, never more than one byte past the cap if it grew since. */
export async function readOpenedImage(image: OpenedImage, maxBytes: number = IMAGE_DATA_URL_MAX_BYTES): Promise<Buffer | null> {
  const buf = Buffer.alloc(Math.min(image.size, maxBytes) + 1);
  let filled = 0;
  while (filled < buf.length) {
    const { bytesRead } = await image.fh.read(buf, filled, buf.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > maxBytes ? null : buf.subarray(0, filled);
}

/** `raw` as a `data:` URL the window can put in an <img>, or why not. */
export async function imageDataUrl(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
  maxBytes: number = IMAGE_DATA_URL_MAX_BYTES,
): Promise<ImageDataUrlResult> {
  const opened = await openImage(raw, roots, home, platform, maxBytes);
  if (!opened.ok) return opened;
  const { image } = opened;
  try {
    const bytes = await readOpenedImage(image, maxBytes);
    if (!bytes) return { ok: false, reason: "too-large" };
    // Re-sniffed from what was read: the file may have been rewritten since its head was looked at.
    const mime = sniffImageMime(bytes.subarray(0, 16));
    if (!mime) return { ok: false, reason: "missing" };
    return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, mime, size: bytes.length, mtimeMs: image.mtimeMs };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    await image.fh.close().catch(() => undefined);
  }
}
