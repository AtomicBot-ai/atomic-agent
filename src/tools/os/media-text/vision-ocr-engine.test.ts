import { describe, expect, it, vi } from "vitest";

import { VisionUnsupportedError, type VisionRequest } from "../../../llm/index.js";
import type { PdfPageImage } from "../read-document/extractors/pdf-page-images.js";
import { buildTestPdf } from "../read-document/extractors/scan-pdf-test-helpers.js";
import type { VisionModel } from "./media-text.js";
import { createVisionOcrEngine, SCAN_PAGE_TEXT_PROMPT, VISION_OCR_ENGINE_ID } from "./vision-ocr-engine.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function visionModel(over: { canSee?: boolean; answer?: (req: VisionRequest) => string; error?: (page: number) => Error | undefined } = {}) {
  let call = 0;
  const describeImage = vi.fn(async (req: VisionRequest) => {
    call += 1;
    const error = over.error?.(call);
    if (error) throw error;
    return { text: over.answer?.(req) ?? `  Договор аренды, страница ${call}  `, durationMs: 1 };
  });
  const model = { name: "local-vlm", capabilities: { vision: over.canSee ?? true }, describeImage } as unknown as VisionModel;
  return { model, describeImage };
}

const pictures = (pages: readonly number[]): PdfPageImage[] => pages.map((page) => ({ page, png: PNG }));
const REQUEST = { data: Buffer.from("%PDF"), sourcePath: "/x/scan.pdf", pages: [1, 2], languages: ["rus", "eng"] };

describe("createVisionOcrEngine (ATO-2205)", () => {
  it("is unavailable, with the reason, without a vision model or with one that cannot see", async () => {
    expect(await createVisionOcrEngine({}).unavailableReason(["rus"])).toBe("no vision model is configured");
    const blind = visionModel({ canSee: false }).model;
    expect(await createVisionOcrEngine({ vision: blind }).unavailableReason(["rus"])).toBe("local-vlm cannot read images");
    expect(await createVisionOcrEngine({ vision: visionModel().model }).unavailableReason(["rus"])).toBeUndefined();
  });

  it("reads the provider on every call", async () => {
    let current: VisionModel | undefined;
    const engine = createVisionOcrEngine({ vision: () => current });
    expect(await engine.unavailableReason([])).toBe("no vision model is configured");
    current = visionModel().model;
    expect(await engine.unavailableReason([])).toBeUndefined();
  });

  it("sends each page picture as PNG with the scan prompt and returns the trimmed text per page", async () => {
    const { model, describeImage } = visionModel();
    const pageImages = vi.fn(async (_data: Buffer, pages: readonly number[]) => pictures(pages));
    const engine = createVisionOcrEngine({ vision: model, pageImages });
    expect(engine.id).toBe(VISION_OCR_ENGINE_ID);
    const run = await engine.recognizePdfPages(REQUEST);
    expect(pageImages).toHaveBeenCalledWith(REQUEST.data, [1, 2], undefined);
    expect(describeImage).toHaveBeenCalledTimes(2);
    const first = describeImage.mock.calls[0]![0];
    expect(first.prompt).toBe(SCAN_PAGE_TEXT_PROMPT);
    expect(first.images).toEqual([{ id: 1, bytes: PNG, mimeType: "image/png" }]);
    expect(run).toEqual({
      pages: [
        { page: 1, text: "Договор аренды, страница 1" },
        { page: 2, text: "Договор аренды, страница 2" },
      ],
      warnings: [],
    });
  });

  it("keeps going past a page without a picture, a too-big picture or a failed call", async () => {
    const { model, describeImage } = visionModel({ error: (call) => (call === 1 ? new Error("timeout") : undefined) });
    const pageImages = async (): Promise<PdfPageImage[]> => [
      { page: 1, png: PNG },
      { page: 2, warning: "no image on the page" },
      { page: 3, png: Buffer.alloc(64) },
      { page: 4, png: PNG },
    ];
    const run = await createVisionOcrEngine({ vision: model, pageImages, maxImageBytes: 32 }).recognizePdfPages({ ...REQUEST, pages: [1, 2, 3, 4] });
    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(run.pages).toEqual([{ page: 4, text: "Договор аренды, страница 2" }]);
    expect(run.warnings).toEqual([
      "page 1: vision model failed (timeout)",
      "page 2: no image on the page, not recognised",
      "page 3: page image is 64 bytes, over 32, not recognised",
    ]);
  });

  it("stops the whole run when the model turns out not to take images", async () => {
    const { model } = visionModel({ error: () => new VisionUnsupportedError("local-vlm") });
    const engine = createVisionOcrEngine({ vision: model, pageImages: async (_d, pages) => pictures(pages) });
    await expect(engine.recognizePdfPages(REQUEST)).rejects.toBeInstanceOf(VisionUnsupportedError);
  });

  it("reads real page pictures out of a scanned PDF by default", async () => {
    const { model, describeImage } = visionModel();
    const data = buildTestPdf([{ image: { width: 240, height: 320 } }, { text: "digital page with a text layer" }]);
    const run = await createVisionOcrEngine({ vision: model }).recognizePdfPages({ ...REQUEST, data, pages: [1] });
    expect(run.pages).toEqual([{ page: 1, text: "Договор аренды, страница 1" }]);
    const sent = describeImage.mock.calls[0]![0].images[0]!;
    expect(Buffer.from(sent.bytes).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
