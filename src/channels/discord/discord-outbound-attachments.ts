/**
 * Deliver `reply.attachments` to a Discord channel.
 *
 * The reply text goes first through the ordinary `sendMessage` path;
 * the files follow, one message each, through `api.sendFile` — a
 * multipart upload on the same messages endpoint. Discord renders
 * images inline on its own, so unlike Telegram there is no photo /
 * document split: every file is uploaded as-is.
 *
 * Nothing here throws: every file resolves to `sent` or to a `failed`
 * entry with a reason, and the caller posts one notice per failure.
 * A reply whose file could not be delivered must say so in the
 * channel — the operator asked for the file, not for the sentence
 * announcing it.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { DiscordApiError } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";

/**
 * Sanity cap before the bytes are even read. Discord's real limit
 * depends on the server (10 MB unboosted, up to 100 MB at boost
 * level 3), so the channel does not pretend to know it: anything up
 * to the largest limit Discord offers is attempted, and a 413 from
 * Discord is turned into a reason the operator can act on.
 */
export const DISCORD_UPLOAD_SANITY_LIMIT_BYTES = 100 * 1024 * 1024;

/** The narrow surface `sendAttachments` needs from `DiscordApi`. */
export interface DiscordFileSender {
  sendFile(
    channelId: string,
    file: { path: string; filename: string },
  ): Promise<unknown>;
}

export interface SendDiscordAttachmentsOptions {
  api: DiscordFileSender;
  channelId: string;
  /** Absolute paths, as validated by the `reply` tool. */
  paths: ReadonlyArray<string>;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface SendDiscordAttachmentsResult {
  sent: number;
  failed: Array<{ path: string; reason: string }>;
}

export async function sendDiscordAttachments(
  opts: SendDiscordAttachmentsOptions,
): Promise<SendDiscordAttachmentsResult> {
  const result: SendDiscordAttachmentsResult = { sent: 0, failed: [] };
  for (const path of opts.paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        result.failed.push({ path, reason: "not a file" });
        continue;
      }
      if (info.size > DISCORD_UPLOAD_SANITY_LIMIT_BYTES) {
        result.failed.push({
          path,
          reason: "over Discord's 100 MB upload limit",
        });
        continue;
      }
    } catch {
      result.failed.push({ path, reason: "file not found" });
      continue;
    }
    try {
      await opts.api.sendFile(opts.channelId, {
        path,
        filename: basename(path),
      });
      result.sent += 1;
    } catch (err) {
      const reason = describeUploadError(err);
      result.failed.push({ path, reason });
      opts.logger?.warn("discord: attachment send failed", {
        channelId: opts.channelId,
        path,
        error: reason,
      });
    }
  }
  return result;
}

/**
 * Discord answers an oversized upload with HTTP 413 and nothing more
 * useful; say what it means. Every other error keeps its (scrubbed)
 * message.
 */
function describeUploadError(err: unknown): string {
  if (err instanceof DiscordApiError && err.status === 413) {
    return "over this server's upload limit (Discord returned HTTP 413)";
  }
  return scrubDiscordError(err);
}

/** The notice posted for one undelivered attachment. */
export function formatDiscordAttachmentFailure(failure: {
  path: string;
  reason: string;
}): string {
  return `Could not send ${basename(failure.path)}: ${failure.reason}`;
}
