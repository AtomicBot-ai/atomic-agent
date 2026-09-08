/**
 * Deliver `reply.attachments` to a Telegram chat.
 *
 * The reply text goes first through the ordinary `sendOutbound` path;
 * the files follow, one message each, through `api.sendFile` — the
 * grammy adapter's thin wrapper over `sendPhoto` / `sendDocument`.
 * Images that fit Telegram's photo limits go as photos so they render
 * inline; everything else (and any image Telegram rejects as a photo)
 * goes as a document, which preserves the bytes exactly.
 *
 * Nothing here throws: every file resolves to `sent` or to a `failed`
 * entry with a reason, and the caller posts one plain-text notice per
 * failure. A reply whose file could not be delivered must say so in
 * the chat — the operator asked for the file, not for the sentence
 * announcing it.
 */

import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { TelegramApi, TelegramLogger } from "./outbound-sender.js";
import { scrubErrorMessage } from "./telegram-channel-types.js";

/** Bot API ceiling for a file uploaded with `sendPhoto`. */
export const TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

/** Bot API ceiling for a file uploaded with `sendDocument`. */
export const TELEGRAM_DOCUMENT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export type OutboundFileKind = "photo" | "document";

/** What the adapter is asked to send. */
export interface OutboundFile {
  /** Absolute path on disk. */
  path: string;
  kind: OutboundFileKind;
}

export interface SendAttachmentsOptions {
  api: TelegramApi;
  chatId: number;
  /** Absolute paths, as validated by the `reply` tool. */
  paths: ReadonlyArray<string>;
  logger?: TelegramLogger;
}

export interface SendAttachmentsResult {
  sent: number;
  failed: Array<{ path: string; reason: string }>;
}

/** Extensions Telegram renders inline as a photo. GIFs are animations, not photos — they go as documents. */
const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * Photo when the extension says image and the size fits the photo
 * ceiling; document otherwise. Telegram re-encodes photos, so a file
 * whose exact bytes matter should not be an image — but an image that
 * arrives as a document does not render inline, and for a screenshot
 * "see it now" beats "download it".
 */
export function classifyOutboundFile(path: string, bytes: number): OutboundFileKind {
  if (bytes > TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES) return "document";
  return PHOTO_EXTENSIONS.has(extname(path).toLowerCase()) ? "photo" : "document";
}

export async function sendAttachments(
  opts: SendAttachmentsOptions,
): Promise<SendAttachmentsResult> {
  const result: SendAttachmentsResult = { sent: 0, failed: [] };
  const sendFile = opts.api.sendFile;
  for (const path of opts.paths) {
    if (!sendFile) {
      result.failed.push({
        path,
        reason: "file upload is not supported by this bot adapter",
      });
      continue;
    }
    let bytes: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        result.failed.push({ path, reason: "not a file" });
        continue;
      }
      bytes = info.size;
    } catch {
      result.failed.push({ path, reason: "file not found" });
      continue;
    }
    if (bytes > TELEGRAM_DOCUMENT_UPLOAD_LIMIT_BYTES) {
      result.failed.push({
        path,
        reason: "over Telegram's 50 MB upload limit",
      });
      continue;
    }
    const kind = classifyOutboundFile(path, bytes);
    try {
      await sendFile.call(opts.api, opts.chatId, { path, kind });
      result.sent += 1;
      continue;
    } catch (err) {
      if (kind !== "photo") {
        result.failed.push({ path, reason: scrubErrorMessage(err) });
        opts.logger?.warn("telegram: attachment send failed", {
          chatId: opts.chatId,
          path,
          kind,
          error: scrubErrorMessage(err),
        });
        continue;
      }
      // Telegram rejects photos for reasons unrelated to the bytes
      // (odd dimensions, a large side ratio, a PNG it will not
      // re-encode). The same file goes through as a document.
      opts.logger?.warn("telegram: photo send rejected, retrying as document", {
        chatId: opts.chatId,
        path,
        error: scrubErrorMessage(err),
      });
    }
    try {
      await sendFile.call(opts.api, opts.chatId, { path, kind: "document" });
      result.sent += 1;
    } catch (err) {
      result.failed.push({ path, reason: scrubErrorMessage(err) });
      opts.logger?.warn("telegram: attachment send failed", {
        chatId: opts.chatId,
        path,
        kind: "document",
        error: scrubErrorMessage(err),
      });
    }
  }
  return result;
}

/** The plain-text notice posted for one undelivered attachment. */
export function formatAttachmentFailure(failure: { path: string; reason: string }): string {
  return `Could not send ${basename(failure.path)}: ${failure.reason}`;
}
