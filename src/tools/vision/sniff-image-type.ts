/**
 * Magic-number sniffing for the image formats the vision path can send.
 *
 * A filename is a claim, not evidence. Everything that reaches the agent
 * from a chat app arrives under a name the *client* chose: Telegram and
 * Discord hand us `photo.jpg` for a screenshot that is really PNG, and
 * the inbox stores it under that name because nothing on the write path
 * looks at the bytes. Anything downstream that types the file from its
 * extension then labels those bytes wrong, and a provider that is handed
 * `data:image/jpeg;base64,<PNG>` answers with an opaque 400 that names
 * neither the file nor the mismatch.
 *
 * So: a small pure function over a byte prefix, deliberately kept in its
 * own module with no I/O and no path handling, so the same rule can be
 * reused elsewhere later (the channel inbox is the obvious next caller)
 * without dragging the vision tool along with it.
 *
 * Scope is on purpose the four formats `vision.describe` can actually
 * send — the ones in `MIME_BY_EXT` in `load-image.ts`. HEIC, AVIF, BMP
 * and friends are *not* sniffed: adding a signature here without adding
 * the format to the accepted set would turn "unrecognised, fall back to
 * the extension" into a hard rejection for files that work today.
 */

/** The image types this sniffer can recognise from bytes alone. */
export type SniffedImageType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Longest prefix any signature below inspects: the WebP check reads
 * `WEBP` at offset 8..11. Callers that stream (rather than read the
 * whole file, as `loadImageFile` does) only need this many bytes.
 */
export const IMAGE_SNIFF_PREFIX_BYTES = 12;

interface BytePattern {
  offset: number;
  /** Exact bytes expected at `offset`. */
  bytes: readonly number[];
}

interface ImageSignature {
  mimeType: SniffedImageType;
  /** All patterns must match for the signature to claim the bytes. */
  patterns: readonly BytePattern[];
}

const ascii = (text: string): readonly number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

/**
 * Ordered so the cheapest and most common checks come first; the first
 * signature whose patterns all match wins. The orderings are mutually
 * exclusive anyway — no two of these four share a first byte — so this
 * is about work done, not about ambiguity.
 */
const SIGNATURES: readonly ImageSignature[] = [
  {
    mimeType: "image/png",
    patterns: [
      { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    ],
  },
  // SOI + the first marker byte. Three bytes is the conventional JPEG
  // sniff: the fourth byte varies across JFIF / Exif / raw encoders and
  // pinning it would reject valid files.
  {
    mimeType: "image/jpeg",
    patterns: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  },
  { mimeType: "image/gif", patterns: [{ offset: 0, bytes: ascii("GIF87a") }] },
  { mimeType: "image/gif", patterns: [{ offset: 0, bytes: ascii("GIF89a") }] },
  // RIFF container with a WEBP form type. The four bytes between them
  // are the chunk length and carry no signal.
  {
    mimeType: "image/webp",
    patterns: [
      { offset: 0, bytes: ascii("RIFF") },
      { offset: 8, bytes: ascii("WEBP") },
    ],
  },
];

function matchesPattern(bytes: Uint8Array, pattern: BytePattern): boolean {
  if (bytes.length < pattern.offset + pattern.bytes.length) return false;
  for (let i = 0; i < pattern.bytes.length; i += 1) {
    if (bytes[pattern.offset + i] !== pattern.bytes[i]) return false;
  }
  return true;
}

/**
 * Identify an image from its leading bytes, or `null` when the prefix
 * matches no supported signature — including when it is too short to
 * decide. `null` means "no opinion", never "not an image": the caller
 * decides what to do with an unknown blob (`loadImageFile` falls back
 * to the file extension so nothing that works today starts failing).
 *
 * Reads at most `IMAGE_SNIFF_PREFIX_BYTES` bytes and bails out of each
 * signature at the first mismatching byte, so passing a whole 8 MB
 * screenshot costs the same as passing its first twelve bytes.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  for (const signature of SIGNATURES) {
    if (signature.patterns.every((pattern) => matchesPattern(bytes, pattern))) {
      return signature.mimeType;
    }
  }
  return null;
}
