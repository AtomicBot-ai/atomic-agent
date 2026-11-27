import { deflateSync } from "node:zlib";

import { rowBytes, type RawImage } from "./raw-image.js";

/**
 * A minimal PNG writer for {@link RawImage} (ATO-2205): IHDR, one IDAT,
 * IEND, filter 0 on every row. Enough to hand a scanned PDF page to a
 * vision model without a canvas or an image library in the bundle.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour types by channel count. */
const COLOR_TYPE: Record<RawImage["channels"], number> = { 1: 0, 3: 2, 4: 6 };

export function encodePng(image: RawImage): Buffer {
  const stride = rowBytes(image);
  if (image.data.length < stride * image.height) {
    throw new Error(`image data too short: ${image.data.length} < ${stride * image.height}`);
  }
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    // Byte 0 of each row is the filter type, 0 = none.
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = image.bitDepth;
  header[9] = COLOR_TYPE[image.channels];
  // Bytes 10..12: compression 0, filter method 0, no interlace.
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const typeAndBody = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const out = Buffer.alloc(4 + typeAndBody.length + 4);
  out.writeUInt32BE(body.length, 0);
  typeAndBody.copy(out, 4);
  // Layout: length (4) | type + body | CRC over type + body (4).
  out.writeUInt32BE(crc32(typeAndBody), 4 + typeAndBody.length);
  return out;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (ISO 3309), as the PNG spec defines it for chunks. */
export function crc32(bytes: Uint8Array): number {
  crcTable ??= buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
