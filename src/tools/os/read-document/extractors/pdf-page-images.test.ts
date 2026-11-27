import { describe, expect, it } from "vitest";

import { extractPdfPageImages } from "./pdf-page-images.js";
import { buildTestPdf } from "./scan-pdf-test-helpers.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR is the first chunk: 8 signature + 4 length + 4 type.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("extractPdfPageImages (ATO-2205, real pdfjs)", () => {
  const pdf = buildTestPdf([
    { image: { width: 300, height: 400, gray: 128 } },
    { text: "A digital page with a real text layer" },
  ]);

  it("pulls the scanned page's image out as PNG at its own size", async () => {
    const [scan] = await extractPdfPageImages(pdf, [1]);
    expect(scan?.page).toBe(1);
    expect(scan?.warning).toBeUndefined();
    expect(scan?.png?.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    expect(pngSize(scan!.png!)).toEqual({ width: 300, height: 400 });
    expect(scan).toMatchObject({ width: 300, height: 400 });
  });

  it("shrinks a large page image so its longer side fits maxSide", async () => {
    const [scan] = await extractPdfPageImages(pdf, [1], { maxSide: 100 });
    expect(pngSize(scan!.png!)).toEqual({ width: 75, height: 100 });
  });

  it("answers a warning, not a throw, for a page with no image, a missing page and an oversized image", async () => {
    const out = await extractPdfPageImages(pdf, [2, 9]);
    expect(out).toEqual([
      { page: 2, warning: "no image on the page" },
      { page: 9, warning: "no such page" },
    ]);
    const [big] = await extractPdfPageImages(pdf, [1], { maxPixels: 1000 });
    expect(big).toEqual({ page: 1, warning: "page image too large (300x400)" });
  });

  it("stops at an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await extractPdfPageImages(pdf, [1, 2], { signal: controller.signal })).toEqual([]);
  });
});
