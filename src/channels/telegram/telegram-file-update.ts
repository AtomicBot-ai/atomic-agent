/**
 * Projection of a file-bearing Telegram message onto the narrow shape
 * the inbound handler consumes.
 *
 * Kept free of grammy types so tests can fabricate messages and so
 * `inbound-handler.ts` stays independent of the adapter. The Bot API
 * spreads files over eight optional fields (`photo`, `document`,
 * `video`, …); `pickTelegramFile` collapses them into one
 * `InboundTelegramFile` with a `kind`, choosing the largest rendition
 * of a photo and preferring `animation` over the `document` alias the
 * API sends alongside it.
 */

export type TelegramFileKind =
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "video_note"
  | "sticker";

export interface InboundTelegramFile {
  kind: TelegramFileKind;
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

/**
 * A private-chat update carrying a file. Same envelope as
 * `InboundTextUpdate`; the text lives in `caption` (possibly absent)
 * and an album member carries the `media_group_id` shared by its
 * siblings.
 */
export interface InboundFileUpdate {
  from?: { id: number };
  chat: { id: number; type: string };
  message_id: number;
  caption?: string;
  media_group_id?: string;
  file: InboundTelegramFile;
}

interface FileLike {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

/** Structural subset of a Bot API `Message` the projection reads. */
export interface TelegramFileMessage {
  photo?: ReadonlyArray<FileLike & { width?: number; height?: number }>;
  animation?: FileLike;
  video_note?: FileLike;
  video?: FileLike;
  voice?: FileLike;
  audio?: FileLike;
  sticker?: FileLike & { is_animated?: boolean; is_video?: boolean };
  document?: FileLike;
}

/**
 * Pick the one file a message carries. Order matters in two places:
 * `animation` must beat `document` because Telegram sends a GIF under
 * both keys, and `photo` is an array of renditions of which only the
 * largest is worth downloading.
 */
export function pickTelegramFile(
  msg: TelegramFileMessage,
): InboundTelegramFile | null {
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo.reduce((a, b) =>
      (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a,
    );
    return project("photo", best);
  }
  if (msg.animation) return project("animation", msg.animation);
  if (msg.video_note) return project("video_note", msg.video_note);
  if (msg.video) return project("video", msg.video);
  if (msg.voice) return project("voice", msg.voice);
  if (msg.audio) return project("audio", msg.audio);
  if (msg.sticker) {
    const s = msg.sticker;
    const ext = s.is_animated ? "tgs" : s.is_video ? "webm" : "webp";
    const mime = s.is_animated
      ? "application/x-tgsticker"
      : s.is_video
        ? "video/webm"
        : "image/webp";
    return project("sticker", {
      ...s,
      file_name: `sticker.${ext}`,
      mime_type: s.mime_type ?? mime,
    });
  }
  if (msg.document) return project("document", msg.document);
  return null;
}

function project(kind: TelegramFileKind, f: FileLike): InboundTelegramFile {
  return {
    kind,
    file_id: f.file_id,
    ...(f.file_unique_id !== undefined ? { file_unique_id: f.file_unique_id } : {}),
    ...(typeof f.file_size === "number" ? { file_size: f.file_size } : {}),
    ...(typeof f.file_name === "string" ? { file_name: f.file_name } : {}),
    ...(typeof f.mime_type === "string" ? { mime_type: f.mime_type } : {}),
  };
}
