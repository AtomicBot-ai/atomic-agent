import { describe, expect, it } from "vitest";

import {
  assessAndOcr,
  DEFAULT_OCR_LANGUAGES,
  mergeOcrText,
  type OcrEngine,
  type OcrPageRequest,
} from "./ocr-engine.js";
import type { PageText } from "./scan-detection.js";

const REAL_TEXT = "Счёт-фактура № 77, итого к оплате 12 500 руб.";
const INPUT = { data: Buffer.from("%PDF-1.4"), sourcePath: "/tmp/scan.pdf" };

function fakeEngine(
  overrides: Partial<OcrEngine> = {},
  seen: OcrPageRequest[] = [],
): OcrEngine {
  return {
    id: "fake-ocr",
    unavailableReason: async () => undefined,
    recognizePdfPages: async (req) => {
      seen.push(req);
      return {
        pages: req.pages.map((page) => ({
          page,
          text: `recognised text of page ${page} long enough`,
        })),
        warnings: [],
      };
    },
    ...overrides,
  };
}

describe("assessAndOcr", () => {
  it("only assesses when no engine is plugged in (today's default)", async () => {
    const pages: PageText[] = [{ page: 1, text: "" }];
    const warnings: string[] = [];
    const out = await assessAndOcr(pages, INPUT, warnings);
    expect(out.assessment.status).toBe("scanned");
    expect(out.ocrEngineId).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(pages[0]?.text).toBe("");
  });

  it("asks the engine only for pages without a text layer, rus+eng by default", async () => {
    const seen: OcrPageRequest[] = [];
    const pages: PageText[] = [
      { page: 1, text: REAL_TEXT },
      { page: 2, text: "" },
      { page: 3, text: "" },
    ];
    const out = await assessAndOcr(pages, INPUT, [], fakeEngine({}, seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pages).toEqual([2, 3]);
    expect(seen[0]?.languages).toEqual(DEFAULT_OCR_LANGUAGES);
    expect(DEFAULT_OCR_LANGUAGES).toEqual(["rus", "eng"]);
    expect(out.ocrEngineId).toBe("fake-ocr");
    expect(out.assessment.status).toBe("ok");
    expect(pages[0]?.text).toBe(REAL_TEXT);
    expect(pages[1]?.text).toContain("page 2");
  });

  it("does not call the engine when every page already has text", async () => {
    const seen: OcrPageRequest[] = [];
    const pages: PageText[] = [{ page: 1, text: REAL_TEXT }];
    const out = await assessAndOcr(pages, INPUT, [], fakeEngine({}, seen));
    expect(seen).toEqual([]);
    expect(out.ocrEngineId).toBeUndefined();
  });

  it("reports an unavailable engine as a warning and keeps the pages missing", async () => {
    const seen: OcrPageRequest[] = [];
    const pages: PageText[] = [{ page: 1, text: "" }];
    const warnings: string[] = [];
    const out = await assessAndOcr(
      pages,
      INPUT,
      warnings,
      fakeEngine({ unavailableReason: async () => "rus language data not installed" }, seen),
    );
    expect(seen).toEqual([]);
    expect(out.assessment.status).toBe("scanned");
    expect(out.ocrEngineId).toBeUndefined();
    expect(warnings[0]).toContain("rus language data not installed");
  });

  it("never fails the read when the engine throws", async () => {
    const pages: PageText[] = [{ page: 1, text: "" }];
    const warnings: string[] = [];
    const out = await assessAndOcr(
      pages,
      INPUT,
      warnings,
      fakeEngine({
        recognizePdfPages: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out.assessment.status).toBe("scanned");
    expect(warnings[0]).toContain("fake-ocr failed: boom");
  });
});

describe("mergeOcrText", () => {
  it("never overwrites a page that already had a text layer", () => {
    const pages: PageText[] = [
      { page: 1, text: REAL_TEXT },
      { page: 2, text: "" },
    ];
    mergeOcrText(pages, [
      { page: 1, text: "engine garbage" },
      { page: 2, text: "  recognised  " },
    ]);
    expect(pages[0]?.text).toBe(REAL_TEXT);
    expect(pages[1]?.text).toBe("recognised");
  });
});
