/**
 * ATO-405 — files attached in the composer, saved where the agent reads them.
 *
 * The desktop and its agent share one machine, so an attachment never travels
 * as bytes in the chat request (`/v1/chat/completions` takes one string, and
 * its body is capped at 1 MiB). The file is written to the desktop's inbox,
 * `<stateDir>/inbox/desktop/<yyyy-mm-dd>/<HHMMSS>-<name>`, and the message
 * gains the same `[attachments]` block Telegram and Discord append
 * (src/channels/attachments/inbox.ts). The agent already knows that block: it
 * reads a path named there with `os.fs.read_document`, or looks at it with
 * `vision.describe`, and a path the user named widens its read scope.
 *
 * `sanitizeFilename`, the MIME / extension tables, `formatBytes`,
 * `formatAttachmentsBlock` and `buildAttachmentUserMessage` are ported from
 * that file and must stay byte-identical in what they print: the renderer
 * (renderer/attachments.js) parses the block back out of a stored message to
 * draw it as chips, and the agent was prompted against this exact shape.
 *
 * The file's type comes from its bytes, never its name (the #399 lesson: a
 * client calls a PNG `photo.jpg`, and a provider handed the wrong type answers
 * with a 400 that names nothing). An image whose name says otherwise is saved
 * under the extension its bytes call for.
 *
 * Pure but for the file system: no Electron import, so the unit suite loads it
 * from `out/main` and drives it against a throwaway state directory.
 */

import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";

/** Biggest image the agent is sent, after the renderer's downscale. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Biggest document. */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

export type AttachmentKind = "image" | "document";

export type AttachmentSource =
  /** A file on disk (picked in the open dialog): copied into the inbox. */
  | { path: string; name?: string }
  /** Bytes the window holds (a drop, a paste, a downscaled image). */
  | { bytes: Uint8Array; name?: string; mimeType?: string };

export type SaveResult =
  | { ok: true; path: string; name: string; bytes: number; mimeType: string | null; kind: AttachmentKind }
  | { ok: false; reason: "too-large" | "not-an-image" | "unreadable" | "not-a-file"; error: string };

/* ---------------- ported from src/channels/attachments/inbox.ts ---------------- */

/** Upper bound on collision retries before giving up on a name. */
const MAX_NAME_ATTEMPTS = 1000;

/** Longest basename we will write, extension included. */
const MAX_NAME_LENGTH = 100;

const EXT_BY_MIME: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/heic", ".heic"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["audio/ogg", ".ogg"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/x-m4a", ".m4a"],
  ["audio/wav", ".wav"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["application/json", ".json"],
  ["application/x-tgsticker", ".tgs"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
]);

const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ...Array.from(EXT_BY_MIME.entries()).map(
    ([mime, ext]) => [ext, mime] as const,
  ),
  [".jpeg", "image/jpeg"],
  // Desktop additions: the document types the composer accepts
  // (renderer/attachments.js DOCUMENT_EXTENSIONS) that the channel table
  // does not name. Everything else textual is `text/plain` (see mimeFor).
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xls", "application/vnd.ms-excel"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  // Archives the agent opens with os.fs.archive.* (a .zip is named by its bytes).
  [".tar", "application/x-tar"],
  [".gz", "application/gzip"],
  [".tgz", "application/gzip"],
]);

/**
 * Reduce a client-supplied filename to something safe to create under
 * the inbox. Returns `null` when nothing usable is left (empty, all
 * dots, only control characters) so the caller falls back to `file`.
 */
export function sanitizeFilename(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Basename on both separator families: a client can send `../../x`
  // or `C:\x`, and neither may escape the inbox directory.
  let name = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");
  name = name.replace(/[<>:"|?*]/g, "_");
  name = name.trim().replace(/\s+/g, "_");
  name = name.replace(/^\.+/, "");
  if (name.length === 0) return null;
  if (name.length > MAX_NAME_LENGTH) {
    const ext = extname(name);
    const keep = Math.max(1, MAX_NAME_LENGTH - ext.length);
    name = `${name.slice(0, keep)}${ext}`;
  }
  return name;
}

function withSuffix(base: string, attempt: number): string {
  const ext = extname(base);
  const stem = ext.length > 0 ? base.slice(0, -ext.length) : base;
  return `${stem}-${attempt}${ext}`;
}

function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Human-readable size for the attachments block and chat notices. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const HINT_LINE =
  "The files are saved locally: read them with os.fs.read or os.fs.read_document; use vision.describe for images; open archives with os.fs.archive.list or os.fs.archive.extract.";

export interface SavedAttachment {
  path: string;
  bytes: number;
  mimeType: string | null;
}

export type AttachmentOutcome =
  | { status: "saved"; saved: SavedAttachment }
  | { status: "failed"; name: string; reason: string };

/**
 * The block appended to the user message so the agent sees every file
 * that arrived, where it landed, and which ones did not make it.
 */
export function formatAttachmentsBlock(
  items: ReadonlyArray<AttachmentOutcome>,
): string {
  const lines = items.map((item) =>
    item.status === "saved"
      ? `- ${item.saved.path} (${item.saved.mimeType ?? "unknown type"}, ${formatBytes(item.saved.bytes)})`
      : `- ${item.name}: not saved (${item.reason})`,
  );
  return ["[attachments]", ...lines].join("\n");
}

/**
 * The full user message for a turn that carries files: the caption
 * (or a stand-in when there was none), the attachments block, and a
 * one-line hint about which tools read them — only when at least one
 * file actually landed.
 */
export function buildAttachmentUserMessage(
  caption: string | undefined,
  items: ReadonlyArray<AttachmentOutcome>,
): string {
  const text = caption?.trim() ?? "";
  const savedCount = items.filter((i) => i.status === "saved").length;
  const head =
    text.length > 0
      ? text
      : `The user sent ${items.length === 1 ? "a file" : `${items.length} files`} without a message.`;
  const parts = [head, "", formatAttachmentsBlock(items)];
  if (savedCount > 0) parts.push(HINT_LINE);
  return parts.join("\n");
}

/* ---------------- type from bytes ---------------- */

const SNIFF_BYTES = 8192;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** The image types `vision.describe` can send, from their magic numbers
 *  (src/tools/vision/sniff-image-type.ts), plus PDF and the ZIP container. */
export function sniffMime(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(b, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  return null;
}

/** No NUL byte and valid UTF-8 in the first 8 KB: text, whatever it is called. */
function looksLikeText(b: Uint8Array): boolean {
  const head = b.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  try {
    // A multi-byte character cut at the 8 KB edge is not a reason to refuse.
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === SNIFF_BYTES ? head.subarray(0, SNIFF_BYTES - 4) : head);
    return true;
  } catch {
    return false;
  }
}

const OFFICE_ZIP = new Set([".docx", ".xlsx", ".pptx", ".ods"]);

/**
 * The type the agent is told, judged on the bytes. A recognised signature
 * wins; a ZIP keeps its office type when its name says it is one; text is
 * its extension's text type, else `text/plain`; anything else keeps its
 * extension's type, or none.
 */
export function mimeFor(b: Uint8Array, name: string): string | null {
  const ext = extname(name).toLowerCase();
  const sniffed = sniffMime(b);
  if (sniffed === "application/zip") return OFFICE_ZIP.has(ext) ? MIME_BY_EXT.get(ext)! : sniffed;
  if (sniffed) return sniffed;
  const byExt = MIME_BY_EXT.get(ext) ?? null;
  if (looksLikeText(b)) {
    return byExt && (byExt.startsWith("text/") || byExt === "application/json" || byExt === "application/xml" || byExt === "application/yaml")
      ? byExt : "text/plain";
  }
  // Binary bytes under an image or text name are not what the name says.
  if (byExt && (byExt.startsWith("image/") || byExt.startsWith("text/"))) return null;
  return byExt;
}

/** Extensions the composer offers as images (renderer/attachments.js IMAGE_EXTENSIONS). */
const IMAGE_NAME = /\.(jpe?g|png|webp|gif)$/i;

/** The basename to write: sanitised, and for an image the extension its bytes call for. */
export function inboxBasename(rawName: string | undefined, mimeType: string | null): string {
  const stem = sanitizeFilename(rawName) ?? "file";
  const want = mimeType && mimeType.startsWith("image/") ? EXT_BY_MIME.get(mimeType) : undefined;
  const ext = extname(stem);
  if (want) {
    const have = MIME_BY_EXT.get(ext.toLowerCase());
    if (have === mimeType) return stem;
    return (ext.length > 0 && have?.startsWith("image/") ? stem.slice(0, -ext.length) : stem) + want;
  }
  if (ext.length > 0) return stem;
  const fromMime = mimeType ? EXT_BY_MIME.get(mimeType) : undefined;
  return fromMime ? stem + fromMime : stem;
}

/* ---------------- the inbox ---------------- */

/** `<stateDir>/inbox/desktop` — the channel inbox's layout, under the desktop's own state dir. */
export function inboxDir(stateDir: string): string {
  return join(stateDir, "inbox", "desktop");
}

async function writeUnique(dayDir: string, base: string, bytes: Uint8Array): Promise<{ path: string; name: string }> {
  await mkdir(dayDir, { recursive: true });
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? base : withSuffix(base, attempt);
    const path = join(dayDir, name);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    return { path, name };
  }
  throw new Error(`inbox: no free name for ${base} in ${dayDir}`);
}

function tooLarge(kind: AttachmentKind, bytes: number): SaveResult {
  return kind === "image"
    ? { ok: false, reason: "too-large", error: `Images can be up to 10 MB; this one is ${formatBytes(bytes)} even after resizing` }
    : { ok: false, reason: "too-large", error: `Files can be up to 20 MB; this one is ${formatBytes(bytes)}` };
}

/** Reads a file the open dialog picked, refusing what is not a regular file or is over the document cap before reading it. */
async function readSource(path: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; result: SaveResult }> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    return { ok: false, result: { ok: false, reason: "unreadable", error: "The file could not be read" } };
  }
  if (!info.isFile()) return { ok: false, result: { ok: false, reason: "not-a-file", error: "Only files can be attached, not folders or links" } };
  if (info.size > DOCUMENT_MAX_BYTES) return { ok: false, result: tooLarge("document", info.size) };
  try {
    return { ok: true, bytes: new Uint8Array(await readFile(path)) };
  } catch {
    return { ok: false, result: { ok: false, reason: "unreadable", error: "The file could not be read" } };
  }
}

/**
 * Save one attachment into the inbox. The caller says what it is
 * (`source`); the bytes say what type it is, the limits say whether it goes.
 */
export async function saveAttachment(
  stateDir: string,
  source: AttachmentSource,
  now: () => Date = () => new Date(),
): Promise<SaveResult> {
  let bytes: Uint8Array;
  let rawName: string | undefined;
  if ("path" in source) {
    const read = await readSource(source.path);
    if (!read.ok) return read.result;
    bytes = read.bytes;
    rawName = source.name ?? source.path;
  } else {
    if (!(source.bytes instanceof Uint8Array)) return { ok: false, reason: "unreadable", error: "The file could not be read" };
    bytes = source.bytes;
    rawName = source.name;
  }
  const mimeType = mimeFor(bytes, rawName ?? "");
  const kind: AttachmentKind = mimeType && mimeType.startsWith("image/") ? "image" : "document";
  if (kind === "document" && IMAGE_NAME.test(rawName ?? "")) {
    return { ok: false, reason: "not-an-image", error: "This file is named like an image, but it is not one" };
  }
  const cap = kind === "image" ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (bytes.byteLength > cap) return tooLarge(kind, bytes.byteLength);
  const stamp = now();
  const base = `${formatTime(stamp)}-${inboxBasename(rawName, mimeType)}`;
  const { path, name } = await writeUnique(join(inboxDir(stateDir), formatDay(stamp)), base, bytes);
  return { ok: true, path, name, bytes: bytes.byteLength, mimeType, kind };
}

/**
 * A chip removed before its message went out: its file goes too. Only a
 * regular file inside this desktop's inbox, judged on its real path, is ever
 * deleted; anything else is left alone and reported as not removed.
 */
export async function discardAttachment(stateDir: string, path: string): Promise<boolean> {
  if (typeof path !== "string" || path.length === 0) return false;
  try {
    const root = await realpath(inboxDir(stateDir));
    const real = await realpath(path);
    if (!real.startsWith(root + sep)) return false;
    if (!(await lstat(real)).isFile()) return false;
    await unlink(real);
    return true;
  } catch {
    return false;
  }
}

/** The bytes of an image the open dialog picked, for the window to downscale; capped well above the send limit. */
export const PICKED_IMAGE_READ_MAX = 64 * 1024 * 1024;
export async function readPickedImage(path: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { ok: false, error: "Only files can be attached, not folders or links" };
    if (info.size > PICKED_IMAGE_READ_MAX) return { ok: false, error: `Images can be up to 10 MB; this one is ${formatBytes(info.size)}` };
    const fh = await open(path, "r");
    try {
      return { ok: true, bytes: new Uint8Array(await fh.readFile()) };
    } finally {
      await fh.close();
    }
  } catch {
    return { ok: false, error: "The file could not be read" };
  }
}
