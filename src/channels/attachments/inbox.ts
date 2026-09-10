/**
 * Inbound attachment inbox shared by the chat channels.
 *
 * A file the operator sends through Telegram or Discord has to land on
 * disk before the agent can do anything with it: the model never sees
 * bytes, it sees a path it can hand to `os.fs.read`,
 * `os.fs.read_document` or `vision.describe`. The inbox is that landing
 * zone — `<stateDir>/inbox/<channel>/<yyyy-mm-dd>/<HHMMSS>-<name>` —
 * plus the one-line-per-file block a channel appends to the user
 * message so the agent knows what arrived and where.
 *
 * Names are the platform's, sanitised: the basename only (a client
 * can send `../../x`), control characters and Windows-hostile
 * punctuation stripped, no leading dots, capped in length. A missing
 * extension is inferred from the MIME type, then from the platform's
 * own kind (`photo` → `.jpg`). Collisions get a `-2`, `-3` suffix —
 * the write uses `wx`, so two files saved in the same second can never
 * overwrite each other.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface InboundAttachmentInput {
  /** Filename as the platform reported it, if it reported one. */
  name?: string | undefined;
  /** MIME type as the platform reported it, if it reported one. */
  mimeType?: string | undefined;
  bytes: Uint8Array;
  /**
   * Platform-specific kind (`photo`, `voice`, `sticker`, …). Used as
   * the base name when there is no name and as the last-resort
   * extension hint when neither name nor MIME carries one.
   */
  kind?: string | undefined;
}

export interface SavedAttachment {
  /** Absolute path the bytes were written to. */
  path: string;
  /** Final basename (sanitised, extension inferred, suffix applied). */
  name: string;
  bytes: number;
  /** Reported MIME type, else one inferred from the extension, else `null`. */
  mimeType: string | null;
}

export interface AttachmentInbox {
  readonly dir: string;
  save(input: InboundAttachmentInput): Promise<SavedAttachment>;
}

export interface AttachmentInboxOptions {
  /** Root directory for this channel's inbox, e.g. `<stateDir>/inbox/telegram`. */
  dir: string;
  /** Test seam — replaces `new Date()` for the date / time path parts. */
  now?: () => Date;
}

/**
 * One inbound file's fate, as the channel reports it to the agent and
 * the operator. `failed` is never silent: the channel posts the reason
 * back into the chat and the agent sees it in the attachments block.
 */
export type AttachmentOutcome =
  | { status: "saved"; saved: SavedAttachment }
  | { status: "failed"; name: string; reason: string };

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
]);

/** Last-resort extension per platform kind, when name and MIME give none. */
const EXT_BY_KIND: ReadonlyMap<string, string> = new Map([
  ["photo", ".jpg"],
  ["voice", ".ogg"],
  ["audio", ".mp3"],
  ["video", ".mp4"],
  ["video_note", ".mp4"],
  ["animation", ".mp4"],
  ["sticker", ".webp"],
]);

export function createAttachmentInbox(
  options: AttachmentInboxOptions,
): AttachmentInbox {
  const now = options.now ?? (() => new Date());
  return {
    dir: options.dir,
    async save(input) {
      const stamp = now();
      const dayDir = join(options.dir, formatDay(stamp));
      await mkdir(dayDir, { recursive: true });
      const base = `${formatTime(stamp)}-${attachmentBasename(input)}`;
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = attempt === 1 ? base : withSuffix(base, attempt);
        const path = join(dayDir, name);
        try {
          await writeFile(path, input.bytes, { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
        return {
          path,
          name,
          bytes: input.bytes.byteLength,
          mimeType: resolveMimeType(input.mimeType, name),
        };
      }
      throw new Error(`inbox: no free name for ${base} in ${dayDir}`);
    },
  };
}

/**
 * Reduce a client-supplied filename to something safe to create under
 * the inbox. Returns `null` when nothing usable is left (empty, all
 * dots, only control characters) so the caller falls back to the kind.
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

function attachmentBasename(input: InboundAttachmentInput): string {
  const fromName = sanitizeFilename(input.name);
  const stem = fromName ?? sanitizeFilename(input.kind) ?? "file";
  if (extname(stem).length > 0) return stem;
  const ext =
    extFromMime(input.mimeType) ??
    (input.kind !== undefined ? EXT_BY_KIND.get(input.kind) : undefined) ??
    "";
  return `${stem}${ext}`;
}

function extFromMime(mimeType: string | undefined): string | undefined {
  const normalised = normaliseMime(mimeType);
  return normalised === null ? undefined : EXT_BY_MIME.get(normalised);
}

function resolveMimeType(
  reported: string | undefined,
  name: string,
): string | null {
  const normalised = normaliseMime(reported);
  if (normalised !== null) return normalised;
  return MIME_BY_EXT.get(extname(name).toLowerCase()) ?? null;
}

function normaliseMime(mimeType: string | undefined): string | null {
  if (typeof mimeType !== "string") return null;
  const bare = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return bare.length > 0 && bare.includes("/") ? bare : null;
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

const HINT_LINE =
  "The files are saved locally: read them with os.fs.read or os.fs.read_document; use vision.describe for images.";

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
