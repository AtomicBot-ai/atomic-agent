import { describe, expect, it } from "vitest";

import { downscaleToFit, PDFJS_IMAGE_KIND, rawImageFromPdfJs, rowBytes, unpackBits, type RawImage } from "./raw-image.js";

describe("rawImageFromPdfJs (ATO-2205)", () => {
  it("maps pdfjs image kinds to channels and bit depth", () => {
    expect(rawImageFromPdfJs({ width: 9, height: 1, kind: PDFJS_IMAGE_KIND.GRAYSCALE_1BPP, data: new Uint8Array(2) }))
      .toMatchObject({ channels: 1, bitDepth: 1 });
    expect(rawImageFromPdfJs({ width: 2, height: 1, kind: PDFJS_IMAGE_KIND.RGB_24BPP, data: new Uint8ClampedArray(6) }))
      .toMatchObject({ channels: 3, bitDepth: 8 });
    expect(rawImageFromPdfJs({ width: 2, height: 1, kind: PDFJS_IMAGE_KIND.RGBA_32BPP, data: new Uint8Array(8) }))
      .toMatchObject({ channels: 4, bitDepth: 8 });
  });

  it("answers null for no pixels, an unknown kind or a short buffer", () => {
    expect(rawImageFromPdfJs({ width: 2, height: 1, kind: PDFJS_IMAGE_KIND.RGB_24BPP, data: null })).toBeNull();
    expect(rawImageFromPdfJs({ width: 2, height: 1, kind: 9, data: new Uint8Array(6) })).toBeNull();
    expect(rawImageFromPdfJs({ width: 2, height: 2, kind: PDFJS_IMAGE_KIND.RGB_24BPP, data: new Uint8Array(6) })).toBeNull();
    expect(rawImageFromPdfJs({ width: 0, height: 2, kind: PDFJS_IMAGE_KIND.RGB_24BPP, data: new Uint8Array(6) })).toBeNull();
  });
});

describe("unpackBits / downscaleToFit (ATO-2205)", () => {
  it("expands 1-bit rows (padded to bytes, bit 1 = white) to 8-bit gray", () => {
    const bits: RawImage = { width: 10, height: 1, channels: 1, bitDepth: 1, data: Uint8Array.from([0b10000001, 0b01000000]) };
    expect(rowBytes(bits)).toBe(2);
    expect([...unpackBits(bits).data]).toEqual([255, 0, 0, 0, 0, 0, 0, 255, 0, 255]);
  });

  it("averages whole blocks so the longer side fits", () => {
    const gray: RawImage = { width: 4, height: 2, channels: 1, bitDepth: 8, data: Uint8Array.from([0, 100, 200, 200, 100, 200, 0, 0]) };
    const small = downscaleToFit(gray, 2);
    expect(small).toMatchObject({ width: 2, height: 1, channels: 1, bitDepth: 8 });
    expect([...small.data]).toEqual([100, 100]);
  });

  it("leaves an image that already fits untouched", () => {
    const rgb: RawImage = { width: 2, height: 2, channels: 3, bitDepth: 8, data: new Uint8Array(12) };
    expect(downscaleToFit(rgb, 2000)).toBe(rgb);
  });
});
