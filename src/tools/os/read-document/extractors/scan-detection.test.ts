import { describe, expect, it } from "vitest";

import {
  assessTextLayer,
  buildTextLayerNotice,
  countTextChars,
  hasTextLayer,
  MIN_TEXT_CHARS_PER_PAGE,
  renderPdfPages,
} from "./scan-detection.js";

const REAL_TEXT = "Договор аренды № 12 от 01.02.2026, стороны: ООО Ромашка";

describe("hasTextLayer", () => {
  it("ignores whitespace when counting characters", () => {
    expect(countTextChars(" a \n b\t c ")).toBe(3);
    expect(hasTextLayer("   \n\n  ")).toBe(false);
  });

  it("treats a stray page number or stamp as no text layer", () => {
    expect(hasTextLayer("3")).toBe(false);
    expect(hasTextLayer("Page 1 of 3")).toBe(false);
  });

  it("accepts a short but genuine page at the threshold", () => {
    expect(hasTextLayer("x".repeat(MIN_TEXT_CHARS_PER_PAGE))).toBe(true);
    expect(hasTextLayer("x".repeat(MIN_TEXT_CHARS_PER_PAGE - 1))).toBe(false);
    expect(hasTextLayer(REAL_TEXT)).toBe(true);
  });
});

describe("assessTextLayer", () => {
  it("reports ok when every page has text", () => {
    const a = assessTextLayer([
      { page: 1, text: REAL_TEXT },
      { page: 2, text: REAL_TEXT },
    ]);
    expect(a).toEqual({
      status: "ok",
      pagesChecked: 2,
      pagesWithoutText: [],
      ocrNeeded: false,
    });
    expect(buildTextLayerNotice(a)).toBeUndefined();
  });

  it("reports scanned when no page has text", () => {
    const a = assessTextLayer([
      { page: 1, text: "" },
      { page: 2, text: "  2 " },
      { page: 3, text: "" },
    ]);
    expect(a.status).toBe("scanned");
    expect(a.pagesWithoutText).toEqual([1, 2, 3]);
    expect(a.ocrNeeded).toBe(true);
  });

  it("reports partial for a mixed scan + digital PDF, keeping real page numbers", () => {
    const a = assessTextLayer([
      { page: 4, text: REAL_TEXT },
      { page: 5, text: "" },
      { page: 6, text: REAL_TEXT },
      { page: 7, text: "" },
    ]);
    expect(a.status).toBe("partial");
    expect(a.pagesChecked).toBe(4);
    expect(a.pagesWithoutText).toEqual([5, 7]);
  });

  it("does not call an empty extraction range scanned", () => {
    const a = assessTextLayer([]);
    expect(a.status).toBe("ok");
    expect(a.ocrNeeded).toBe(false);
  });
});

describe("buildTextLayerNotice", () => {
  it("says the PDF looks scanned, with counts and both next steps", () => {
    const notice = buildTextLayerNotice(
      assessTextLayer([
        { page: 1, text: "" },
        { page: 2, text: "" },
      ]),
    );
    expect(notice).toContain("This PDF looks scanned: 2 of 2 pages have no text layer");
    expect(notice).toContain("OCR is needed");
    expect(notice).toContain("vision.describe");
    expect(notice).toContain("pdftoppm");
    expect(notice).toContain("ocrmypdf");
    expect(notice).toContain("rus+eng");
    expect(notice).toContain("do not tell them the document is empty");
  });

  it("lists the missing pages for a partly scanned PDF", () => {
    const notice = buildTextLayerNotice(
      assessTextLayer([
        { page: 1, text: REAL_TEXT },
        { page: 2, text: "" },
        { page: 3, text: "" },
      ]),
    );
    expect(notice).toContain("Part of this PDF looks scanned: 2 of 3 pages");
    expect(notice).toContain("pages 2, 3");
  });

  it("caps a long page list", () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      page: i + 2,
      text: "",
    }));
    pages.unshift({ page: 1, text: REAL_TEXT });
    const notice = buildTextLayerNotice(assessTextLayer(pages)) ?? "";
    expect(notice).toContain("and 10 more");
    expect(notice).not.toContain(" 31,");
  });
});

describe("renderPdfPages", () => {
  it("leads a fully scanned PDF with the notice", () => {
    const pages = [
      { page: 1, text: "" },
      { page: 2, text: "" },
    ];
    const { text, notice } = renderPdfPages(pages, assessTextLayer(pages), true);
    expect(notice).toBeDefined();
    expect(text.startsWith("This PDF looks scanned")).toBe(true);
    expect(text).toContain("--- page 1 ---");
  });

  it("keeps real text first for a partly scanned PDF", () => {
    const pages = [
      { page: 1, text: REAL_TEXT },
      { page: 2, text: "" },
    ];
    const { text, notice } = renderPdfPages(pages, assessTextLayer(pages), true);
    expect(notice).toContain("Part of this PDF looks scanned");
    expect(text.startsWith("--- page 1 ---")).toBe(true);
    expect(text).not.toContain("looks scanned");
  });

  it("returns the notice alone when separators are off and nothing was read", () => {
    const pages = [{ page: 1, text: "" }];
    const { text } = renderPdfPages(pages, assessTextLayer(pages), false);
    expect(text.startsWith("This PDF looks scanned: 1 of 1 pages")).toBe(true);
  });

  it("returns no notice for a normal PDF", () => {
    const pages = [{ page: 1, text: REAL_TEXT }];
    const { text, notice } = renderPdfPages(pages, assessTextLayer(pages), false);
    expect(notice).toBeUndefined();
    expect(text).toBe(REAL_TEXT);
  });
});
