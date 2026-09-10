import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { resolveUserPath } from "../os/expand-home.js";
import { sniffImageType } from "./sniff-image-type.js";

const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

/** How the returned `mimeType` was decided — surfaced for trace logs. */
export type MimeTypeSource = "bytes" | "extension";

export interface LoadedImage {
  /** Absolute path the bytes came from, for trace logs. */
  path: string;
  /** Raw image bytes — not base64 encoded. */
  bytes: Uint8Array;
  /** MIME type: sniffed from the bytes, else derived from the extension. */
  mimeType: string;
  /** Which of the two decided `mimeType`. */
  mimeTypeSource: MimeTypeSource;
}

export interface LoadImageOptions {
  /**
   * Optional — used only to warn when the extension contradicts the
   * bytes. The load succeeds either way; this is a breadcrumb for the
   * operator, not a control flow.
   */
  logger?: StructuredLogger | undefined;
}

export class UnsupportedImageFormatError extends Error {
  constructor(path: string, ext: string) {
    super(
      `unsupported image ${path}: the bytes match no supported image format` +
        ` and the extension "${ext}" is not one of ${Array.from(
          MIME_BY_EXT.keys(),
        ).join(", ")} — accepted formats: ${Array.from(
          new Set(MIME_BY_EXT.values()),
        ).join(", ")}`,
    );
    this.name = "UnsupportedImageFormatError";
  }
}

/**
 * Read an image from disk and return its raw bytes plus the MIME type
 * to label them with. Path resolution mirrors the OS tools' contract:
 * tilde expansion + relative-to-`workingDir`. Used by `vision.describe`
 * so the agent can pass an `image_url` param pointing at a
 * session-relative file.
 *
 * **Precedence: the bytes win.** A filename is a claim made by whoever
 * uploaded the file, and for anything that arrives through a chat
 * channel that is the client, not us — `src/channels/attachments/inbox.ts`
 * stores an attachment under the platform's own (sanitised) filename and
 * never inspects the content, so a PNG screenshot sent from Telegram
 * lands on disk as `photo.jpg`. Typing it from that extension put a
 * `data:image/jpeg;base64,<PNG bytes>` URL on the wire in
 * `describeImageViaOpenAi`, and the provider rejected it with a 400 that
 * named neither the file nor the mismatch.
 *
 * When the bytes match **no** supported signature we deliberately keep
 * the old behaviour and fall back to the extension rather than
 * rejecting: the sniffer only knows four formats, `readFile` gives us no
 * guarantee the prefix is meaningful for every encoder variant in the
 * wild, and a stricter rule would break files that describe fine today.
 * The failure mode we are fixing is a *confidently wrong* label, not a
 * missing one.
 *
 * Consequence worth stating: the file is now read **before** the format
 * is decided, because only the bytes can decide it. A supported image
 * with no extension at all — common for downloads and for `mktemp`-style
 * names — used to be rejected without ever being opened and now loads.
 */
export async function loadImageFile(
  inputPath: string,
  workingDir: string,
  options: LoadImageOptions = {},
): Promise<LoadedImage> {
  const absolute = resolveUserPath(inputPath, workingDir);
  const ext = extname(absolute).toLowerCase();
  const fromExtension = MIME_BY_EXT.get(ext);
  const buffer = await readFile(absolute);
  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const fromBytes = sniffImageType(bytes);
  const mimeType = fromBytes ?? fromExtension;
  if (mimeType === undefined) {
    throw new UnsupportedImageFormatError(absolute, ext || "(none)");
  }
  if (
    fromBytes !== null &&
    fromExtension !== undefined &&
    fromBytes !== fromExtension
  ) {
    // Not an error — we just corrected it — but the next operator
    // staring at an inbox full of misnamed `.jpg` files should not have
    // to rediscover why.
    options.logger?.warn("image extension contradicts its bytes", {
      path: absolute,
      extension: ext,
      fromExtension,
      fromBytes,
    });
  }
  return {
    path: absolute,
    bytes,
    mimeType,
    mimeTypeSource: fromBytes !== null ? "bytes" : "extension",
  };
}
