/**
 * ATO-408: an image file on disk, handed to the window as a `data:` URL.
 *
 * The window's CSP is `img-src 'self' data:`, so a picture the agent made (a
 * reply attachment) or one the person attached can only be shown once main has
 * read it and inlined it. The path comes from the agent's reply or from the
 * window, so it is checked the way a reply chip is (reply-paths.ts): written
 * `~/…` or absolute, never a URL, `..` and symlinks resolved, and only inside
 * the allowed roots (the home folder and the agent's state folder). The file is
 * read only when it is a regular file under the size cap, and its type is taken
 * from its first bytes, not its name: PNG, JPEG, WebP or GIF, nothing else (no
 * SVG, which can carry script).
 *
 * Shared contract (ATO-404–406 use it for the person's own attachments):
 *   BR.imageDataUrl(path) → {ok:true, dataUrl} | {ok:false, reason:'missing'|'too-large'|'outside'}
 * `missing` covers everything that leaves no picture to show: not there, not a
 * file, not a path, or not one of the four image types.
 *
 * Pure but for the file system reads: no Electron import, so the unit suite
 * loads it from `out/main` and drives it against a throwaway "home".
 */

import { open, realpath, stat } from "node:fs/promises";

import { expandHome, isAbsoluteOn, isUnder, pathFor, type Platform } from "./platform.js";

export type ImageDataUrlResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "missing" | "too-large" | "outside" };

/** Bigger than any picture worth showing inline; the data URL is a third larger again. */
export const IMAGE_DATA_URL_MAX_BYTES = 15 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

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

/** The real path of a file the window may read for a picture, or why not. */
export async function imageTarget(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
): Promise<{ ok: true; real: string; size: number } | { ok: false; reason: "missing" | "outside" }> {
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
  return { ok: true, real, size: st.size };
}

/** `raw` as a `data:` URL the window can put in an <img>, or why not. */
export async function imageDataUrl(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
  maxBytes: number = IMAGE_DATA_URL_MAX_BYTES,
): Promise<ImageDataUrlResult> {
  const target = await imageTarget(raw, roots, home, platform);
  if (!target.ok) return target;
  if (target.size > maxBytes) return { ok: false, reason: "too-large" };
  const fh = await open(target.real, "r").catch(() => null);
  if (!fh) return { ok: false, reason: "missing" };
  try {
    // Read what stat promised, and never more than one byte past the cap if it grew since.
    const buf = Buffer.alloc(Math.min(target.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { ok: false, reason: "too-large" };
    const bytes = buf.subarray(0, filled);
    const mime = sniffImageMime(bytes.subarray(0, 16));
    if (!mime) return { ok: false, reason: "missing" };
    return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
