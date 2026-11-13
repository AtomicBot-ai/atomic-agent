/**
 * Image type and pixel size straight from the file header (ATO-660), so
 * sizing a picture in cells needs no image library.
 *
 * PNG: the IHDR chunk is always first, width and height at bytes 16..24.
 * GIF: the logical screen size at bytes 6..10, little-endian.
 * JPEG: walk the markers to the first SOFn frame header.
 */
export type ImageType = "png" | "jpeg" | "gif";

export interface ImageInfo {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x1000000) +
    (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
  );
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/** The type from the magic bytes alone, or `null`. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  return null;
}

function pngSize(bytes: Uint8Array): [number, number] | null {
  // Signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes.length < 24) return null;
  const ihdr = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (ihdr !== "IHDR") return null;
  return [u32be(bytes, 16), u32be(bytes, 20)];
}

function gifSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 10) return null;
  return [u16le(bytes, 6), u16le(bytes, 8)];
}

/** SOF0..SOF15 minus DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): [number, number] | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      // length (2) + precision (1) + height (2) + width (2).
      if (at + 9 > bytes.length) return null;
      return [u16be(bytes, at + 7), u16be(bytes, at + 5)];
    }
    at += 2 + length;
  }
  return null;
}

/** Type and size, or `null` when the bytes are not a PNG/JPEG/GIF we can read. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const type = sniffImageType(bytes);
  if (type === null) return null;
  const size = type === "png" ? pngSize(bytes) : type === "gif" ? gifSize(bytes) : jpegSize(bytes);
  if (size === null) return null;
  const [width, height] = size;
  if (width <= 0 || height <= 0) return null;
  return { type, width, height };
}
