/**
 * ATO-1053: a file the agent made or named, read for the preview panel.
 *
 * The window never touches the disk. It hands main a path (a reply's file
 * chip, an attachment) and gets back what it may show: the start of a text
 * file, a picture as a `data:` URL, a PDF's bytes, or only the name and size.
 * The path is checked exactly as a reply's picture is (image-data-url.ts
 * imageTarget): written `~/…` or absolute, never a URL, `..` and symlinks
 * resolved, and only inside the allowed roots — the home folder, the agent's
 * working folder, its state folder and the temporary folders. The file is
 * opened once and the open handle must be the very file the check passed.
 *
 * Nothing here is run or rendered: an HTML file comes back as text and the
 * window shows it in a sandboxed frame with no scripts; an SVG is text too
 * (it can carry script), never a picture.
 *
 * A large file is never read whole: text stops at PREVIEW_TEXT_MAX_BYTES and
 * says so, pictures and PDFs over their caps come back as "other" with the
 * reason, so the window can still offer Open and Reveal.
 *
 * Pure but for the file system reads: no Electron import, so the unit suite
 * loads it from `out/main` and drives it against a throwaway "home".
 */

import { open, stat } from "node:fs/promises";

import { IMAGE_DATA_URL_MAX_BYTES, imageTarget, sniffImageMime } from "./image-data-url.js";
import { expandHome, pathFor, type Platform } from "./platform.js";

export const PREVIEW_TEXT_MAX_BYTES = 512 * 1024;
export const PREVIEW_PDF_MAX_BYTES = 32 * 1024 * 1024;

export type PreviewKind = "text" | "code" | "markdown" | "csv" | "tsv" | "html" | "image" | "pdf" | "other";

export type FilePreview =
  | {
      ok: true;
      kind: PreviewKind;
      /** The real path that was read (symlinks resolved). */
      path: string;
      name: string;
      ext: string;
      size: number;
      mtimeMs: number;
      /** text, code, markdown, csv, tsv, html: the file's start, decoded as UTF-8. */
      text?: string;
      /** The text stops before the file does. */
      truncated?: boolean;
      /** image: a data: URL. */
      dataUrl?: string;
      /** pdf: the whole file, base64. */
      base64?: string;
      /** other: why there is no preview ("binary", "too-large"). */
      note?: "binary" | "too-large";
    }
  | { ok: false; reason: "missing" | "outside" | "dir" };

const MARKDOWN = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const HTML = new Set([".html", ".htm", ".xhtml"]);
const CODE = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".yaml", ".yml",
  ".toml", ".ini", ".css", ".scss", ".less", ".xml", ".svg", ".lua", ".pl", ".r", ".dart", ".scala", ".vue", ".svelte",
  ".dockerfile", ".gradle", ".makefile", ".env",
]);

/** What a file is shown as, by its extension; the bytes decide picture, PDF and binary. */
export function previewKindFor(ext: string): PreviewKind {
  const e = ext.toLowerCase();
  if (MARKDOWN.has(e)) return "markdown";
  if (HTML.has(e)) return "html";
  if (e === ".csv") return "csv";
  if (e === ".tsv" || e === ".tab") return "tsv";
  if (CODE.has(e)) return "code";
  return "text";
}

/** Text has no NUL bytes in its first few kilobytes; nearly every binary format does. */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/** The bytes read as UTF-8, cut back to a whole character and (when truncated) a whole line. */
export function decodeStart(bytes: Buffer, truncated: boolean): string {
  let end = bytes.length;
  if (truncated) {
    // A UTF-8 sequence cut in half at the end: step back to its first byte.
    let k = end - 1, back = 0;
    while (k >= 0 && back < 4 && (bytes[k] & 0xc0) === 0x80) { k--; back++; }
    if (k >= 0 && bytes[k] >= 0xc0) end = k;
    const nl = bytes.lastIndexOf(0x0a, end - 1);
    if (nl > end / 2) end = nl + 1;
  }
  return bytes.subarray(0, end).toString("utf8").replace(/^﻿/, "");
}

/** The roots a preview may read from (imageRootsFor's, plus the agent's working folder). */
export function previewRootsFor(imageRoots: readonly string[], workingDir: string | null | undefined): string[] {
  return workingDir ? [...imageRoots, workingDir] : [...imageRoots];
}

/** Where a path stands for Open and Reveal: the real file, or why not. */
export async function previewTarget(raw: unknown, roots: readonly string[], home: string, platform: Platform) {
  return imageTarget(raw, roots, home, platform);
}

/** What the preview panel may show for `raw`. */
export async function filePreview(
  raw: unknown,
  roots: readonly string[],
  home: string,
  platform: Platform,
  limits: { text?: number; image?: number; pdf?: number } = {},
): Promise<FilePreview> {
  const textMax = limits.text ?? PREVIEW_TEXT_MAX_BYTES;
  const imageMax = limits.image ?? IMAGE_DATA_URL_MAX_BYTES;
  const pdfMax = limits.pdf ?? PREVIEW_PDF_MAX_BYTES;
  const target = await imageTarget(raw, roots, home, platform);
  if (!target.ok) {
    /* imageTarget says "missing" for a folder too (it passed the roots check
       as written, so this stat stays inside them); the window opens a folder
       in the file manager as before. */
    if (target.reason === "missing" && typeof raw === "string") {
      const st = await stat(expandHome(platform, raw, home)).catch(() => null);
      if (st && st.isDirectory()) return { ok: false, reason: "dir" };
    }
    return { ok: false, reason: target.reason };
  }
  const P = pathFor(platform);
  const name = P.basename(target.real);
  const ext = P.extname(target.real).toLowerCase();
  const fh = await open(target.real, "r").catch(() => null);
  if (!fh) return { ok: false, reason: "missing" };
  try {
    const st = await fh.stat();
    // Swapped for another file (a link put in its place) since it was checked.
    if (st.dev !== target.dev || st.ino !== target.ino) return { ok: false, reason: "outside" };
    if (!st.isFile()) return { ok: false, reason: "missing" };
    const base = { ok: true as const, path: target.real, name, ext, size: st.size, mtimeMs: st.mtimeMs };
    const read = async (n: number): Promise<Buffer> => {
      const buf = Buffer.alloc(Math.max(0, Math.min(n, st.size)));
      let filled = 0;
      while (filled < buf.length) {
        const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buf.subarray(0, filled);
    };
    const head = await read(16);
    const mime = sniffImageMime(head);
    if (mime) {
      if (st.size > imageMax) return { ...base, kind: "other", note: "too-large" };
      const bytes = await read(imageMax);
      // Re-sniffed from what was read: the file may have been rewritten since its head was looked at.
      const again = sniffImageMime(bytes.subarray(0, 16));
      if (!again) return { ...base, kind: "other", note: "binary" };
      return { ...base, kind: "image", dataUrl: `data:${again};base64,${bytes.toString("base64")}` };
    }
    if (head.subarray(0, 5).toString("latin1") === "%PDF-") {
      if (st.size > pdfMax) return { ...base, kind: "other", note: "too-large" };
      const bytes = await read(pdfMax);
      return { ...base, kind: "pdf", base64: bytes.toString("base64") };
    }
    const truncated = st.size > textMax;
    const bytes = await read(textMax);
    if (looksBinary(bytes)) return { ...base, kind: "other", note: "binary" };
    return { ...base, kind: previewKindFor(ext), text: decodeStart(bytes, truncated), truncated };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
