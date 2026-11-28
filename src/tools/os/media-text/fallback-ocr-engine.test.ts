import { describe, expect, it, vi } from "vitest";

import type { OcrEngine } from "../read-document/extractors/ocr-engine.js";
import { createFallbackOcrEngine } from "./fallback-ocr-engine.js";

// ATO-2502: vision model first, tesseract.js when no vision model is ready.
const REQUEST = { data: Buffer.from("%PDF"), sourcePath: "/x/scan.pdf", pages: [1], languages: ["rus", "eng"] };

function engine(id: string, over: { reason?: () => string | undefined; error?: Error } = {}): OcrEngine & { calls: number } {
  const self = {
    id,
    calls: 0,
    unavailableReason: vi.fn(async () => over.reason?.()),
    recognizePdfPages: vi.fn(async () => {
      self.calls += 1;
      if (over.error) throw over.error;
      return { pages: [{ page: 1, text: `read by ${id}` }], warnings: [] };
    }),
  };
  return self;
}

describe("createFallbackOcrEngine", () => {
  it("uses the first ready engine and leaves the rest alone", async () => {
    const vision = engine("vision-model");
    const tesseract = engine("tesseract-js");
    const both = createFallbackOcrEngine([vision, tesseract]);
    expect(both.id).toBe("vision-model or tesseract-js");
    expect((await both.recognizePdfPages(REQUEST)).pages[0]?.text).toBe("read by vision-model");
    expect(tesseract.calls).toBe(0);
  });

  it("falls back when the first is not ready, asked per file", async () => {
    let visionReason: string | undefined = "no vision model is configured";
    const vision = engine("vision-model", { reason: () => visionReason });
    const tesseract = engine("tesseract-js");
    const both = createFallbackOcrEngine([vision, tesseract]);
    expect(await both.unavailableReason(["rus"])).toBeUndefined();
    expect((await both.recognizePdfPages(REQUEST)).pages[0]?.text).toBe("read by tesseract-js");
    visionReason = undefined;
    expect((await both.recognizePdfPages(REQUEST)).pages[0]?.text).toBe("read by vision-model");
  });

  it("joins every reason when none is ready", async () => {
    const both = createFallbackOcrEngine([
      engine("vision-model", { reason: () => "no vision model is configured" }),
      engine("tesseract-js", { reason: () => "tesseract.js is not installed" }),
    ]);
    expect(await both.unavailableReason(["rus"])).toBe("no vision model is configured; tesseract.js is not installed");
    await expect(both.recognizePdfPages(REQUEST)).rejects.toThrow("no OCR engine is ready");
  });

  it("hands the file on when the chosen engine fails for all of it, and throws the last error", async () => {
    const vision = engine("vision-model", { error: new Error("model cannot take images") });
    const tesseract = engine("tesseract-js");
    expect((await createFallbackOcrEngine([vision, tesseract]).recognizePdfPages(REQUEST)).pages[0]?.text).toBe("read by tesseract-js");
    const broken = engine("tesseract-js", { error: new Error("wasm failed") });
    await expect(createFallbackOcrEngine([vision, broken]).recognizePdfPages(REQUEST)).rejects.toThrow("wasm failed");
  });

  it("needs at least one engine", () => {
    expect(() => createFallbackOcrEngine([])).toThrow();
  });
});
