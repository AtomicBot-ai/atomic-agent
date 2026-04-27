import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { resolveUserPath } from "../os/expand-home.js";

const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export interface LoadedImage {
  /** Absolute path the bytes came from, for trace logs. */
  path: string;
  /** Raw image bytes — not base64 encoded. */
  bytes: Uint8Array;
  /** MIME type derived from the file extension. */
  mimeType: string;
}

export class UnsupportedImageFormatError extends Error {
  constructor(path: string, ext: string) {
    super(
      `unsupported image extension "${ext}" for ${path} — accepted: ${Array.from(
        MIME_BY_EXT.keys(),
      ).join(", ")}`,
    );
    this.name = "UnsupportedImageFormatError";
  }
}

/**
 * Read an image from disk and return its raw bytes plus a MIME type
 * inferred from the file extension. Path resolution mirrors the OS
 * tools' contract: tilde expansion + relative-to-`workingDir`. Used
 * by `vision.describe` so the agent can pass an `image_url` param
 * pointing at a session-relative file.
 */
export async function loadImageFile(
  inputPath: string,
  workingDir: string,
): Promise<LoadedImage> {
  const absolute = resolveUserPath(inputPath, workingDir);
  const ext = extname(absolute).toLowerCase();
  const mimeType = MIME_BY_EXT.get(ext);
  if (!mimeType) {
    throw new UnsupportedImageFormatError(absolute, ext || "(none)");
  }
  const buffer = await readFile(absolute);
  return {
    path: absolute,
    bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    mimeType,
  };
}
