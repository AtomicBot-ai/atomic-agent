import { describe, expect, it } from "vitest";
import { readImageInfo, sniffImageType } from "./image-header.js";

/** A PNG header: signature + IHDR chunk with the given size. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** SOI, an APP0 segment to skip, then SOF0 with the size. */
function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0, ...new Array<number>(9).fill(0)]);
}

describe("readImageInfo", () => {
  it("reads PNG size from IHDR", () => {
    expect(readImageInfo(pngHeader(1344, 768))).toEqual({ type: "png", width: 1344, height: 768 });
  });

  it("reads GIF size little-endian", () => {
    expect(readImageInfo(gifHeader(320, 200))).toEqual({ type: "gif", width: 320, height: 200 });
  });

  it("walks JPEG markers to the frame header", () => {
    expect(readImageInfo(jpegHeader(1024, 683))).toEqual({ type: "jpeg", width: 1024, height: 683 });
  });

  it("rejects other formats and truncated headers", () => {
    expect(readImageInfo(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBeNull();
    expect(readImageInfo(pngHeader(10, 10).slice(0, 20))).toBeNull();
    expect(readImageInfo(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageInfo(pngHeader(0, 10))).toBeNull();
  });

  it("sniffs by magic bytes", () => {
    expect(sniffImageType(pngHeader(1, 1))).toBe("png");
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageType(gifHeader(1, 1))).toBe("gif");
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});
