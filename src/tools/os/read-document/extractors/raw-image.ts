/**
 * Raw pixel buffers as pdfjs hands them out for a decoded image XObject,
 * normalised so `png-encode.ts` can write them (ATO-2205).
 *
 * In Node (no `OffscreenCanvas`, `isOffscreenCanvasSupported: false`)
 * pdfjs decodes every image (JPEG, Flate, CCITT, JBIG2) to one of three
 * layouts, its `ImageKind`:
 * - 1: 1 bit gray, rows padded to whole bytes, bit 1 = white
 *   (the same convention as a 1-bit grayscale PNG);
 * - 2: 8-bit RGB;
 * - 3: 8-bit RGBA.
 */

export interface RawImage {
  width: number;
  height: number;
  /** 1 gray, 3 RGB, 4 RGBA. */
  channels: 1 | 3 | 4;
  /** 1 only with `channels: 1` (packed rows); otherwise 8. */
  bitDepth: 1 | 8;
  data: Uint8Array;
}

/** pdfjs `ImageKind` values (`pdfjs-dist` `shared/util.js`). */
export const PDFJS_IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

/** The shape pdfjs resolves an image object id to (without a bitmap). */
export interface PdfJsImageData {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray | null;
}

/** Bytes per row of an image in this layout. */
export function rowBytes(image: Pick<RawImage, "width" | "channels" | "bitDepth">): number {
  return image.bitDepth === 1 ? Math.ceil(image.width / 8) : image.width * image.channels;
}

/**
 * The pdfjs image as a {@link RawImage}, or `null` when it carries no
 * pixel data this module understands (an `ImageBitmap`, an unknown kind,
 * a buffer shorter than its size says).
 */
export function rawImageFromPdfJs(image: PdfJsImageData): RawImage | null {
  const { width, height, kind, data } = image;
  if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let raw: RawImage;
  if (kind === PDFJS_IMAGE_KIND.GRAYSCALE_1BPP) raw = { width, height, channels: 1, bitDepth: 1, data: bytes };
  else if (kind === PDFJS_IMAGE_KIND.RGB_24BPP) raw = { width, height, channels: 3, bitDepth: 8, data: bytes };
  else if (kind === PDFJS_IMAGE_KIND.RGBA_32BPP) raw = { width, height, channels: 4, bitDepth: 8, data: bytes };
  else return null;
  return bytes.length >= rowBytes(raw) * height ? raw : null;
}

/** A 1-bit image as 8-bit gray (0 black, 255 white); other images as is. */
export function unpackBits(image: RawImage): RawImage {
  if (image.bitDepth === 8) return image;
  const { width, height } = image;
  const stride = rowBytes(image);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = image.data[y * stride + (x >> 3)]!;
      out[y * width + x] = byte & (0x80 >> (x & 7)) ? 255 : 0;
    }
  }
  return { width, height, channels: 1, bitDepth: 8, data: out };
}

/**
 * Shrink so the longer side is at most `maxSide`, by averaging square
 * blocks of a whole-number size (a 4960 px wide 600 dpi scan becomes
 * 1654 px with `maxSide` 2000). Box averaging keeps thin strokes of text
 * readable, unlike dropping pixels. An image that already fits comes
 * back unchanged.
 */
export function downscaleToFit(image: RawImage, maxSide: number): RawImage {
  const longer = Math.max(image.width, image.height);
  if (maxSide <= 0 || longer <= maxSide) return image;
  const factor = Math.ceil(longer / maxSide);
  const src = unpackBits(image);
  const { channels } = src;
  const width = Math.max(1, Math.floor(src.width / factor));
  const height = Math.max(1, Math.floor(src.height / factor));
  const out = new Uint8Array(width * height * channels);
  const sums = new Array<number>(channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sums.fill(0);
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * src.width;
        for (let dx = 0; dx < factor; dx += 1) {
          const at = (row + x * factor + dx) * channels;
          for (let c = 0; c < channels; c += 1) sums[c] = sums[c]! + src.data[at + c]!;
        }
      }
      const to = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) out[to + c] = Math.round(sums[c]! / (factor * factor));
    }
  }
  return { width, height, channels, bitDepth: 8, data: out };
}
