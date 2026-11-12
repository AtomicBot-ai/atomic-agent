import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPdfExtractor, pdfExtractor } from "./pdf-extractor.js";
import type { OcrEngine } from "./ocr-engine.js";

const FIXTURE_PATH = resolve(
  fileURLToPath(new URL("../../test-fixtures/sample.pdf", import.meta.url)),
);

describe("pdfExtractor", () => {
  it("extracts text from both pages with `--- page N ---` separators", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pdfExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("pdf");
    expect(result.pageCount).toBe(2);
    expect(result.pagesExtracted).toEqual([1, 2]);
    expect(result.text).toContain("--- page 1 ---");
    expect(result.text).toContain("--- page 2 ---");
    expect(result.text).toMatch(/Sample PDF/);
    expect(result.text).toMatch(/Second Page Heading/);
    expect(result.warnings).toEqual([]);
  });

  it("honours pagesFrom/pagesTo to extract a sub-range", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pdfExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      pagesFrom: 2,
      pagesTo: 2,
    });
    expect(result.pagesExtracted).toEqual([2]);
    expect(result.text).toContain("Second Page Heading");
    expect(result.text).not.toContain("Sample PDF");
  });

  it("honours maxPages cap", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pdfExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      maxPages: 1,
    });
    expect(result.pagesExtracted).toEqual([1]);
    expect(result.text).toContain("Sample PDF");
    expect(result.text).not.toContain("Second Page Heading");
  });

  it("omits page separators when pageSeparators=false", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pdfExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      pageSeparators: false,
    });
    expect(result.text).not.toContain("--- page");
    expect(result.text).toContain("Sample PDF");
  });
});

/**
 * Build a small uncompressed PDF in memory. A `null` page has an empty
 * content stream, which is exactly what a scan looks like to a text
 * extractor: the page exists, but carries no glyphs (the image itself is
 * irrelevant here, pdfjs never reports image pixels as text).
 */
function buildPdf(pageTexts: readonly (string | null)[]): Buffer {
  const pageCount = pageTexts.length;
  const fontObj = 3 + pageCount * 2;
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts
      .map((_, i) => `${3 + i * 2} 0 R`)
      .join(" ")}] /Count ${pageCount} >>`,
  ];
  pageTexts.forEach((text, i) => {
    const content =
      text === null ? "" : `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const DIGITAL_PAGE = "Invoice 77 total due 12500 RUB";

describe("pdfExtractor text-layer detection (ATO-681)", () => {
  it("marks a normal PDF as having a text layer and adds no notice", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pdfExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.textLayer).toEqual({
      status: "ok",
      pagesChecked: 2,
      pagesWithoutText: [],
      ocrNeeded: false,
    });
    expect(result.text).not.toContain("looks scanned");
  });

  it("flags a PDF with no text layer as scanned and leads with the notice", async () => {
    const data = buildPdf([null, null, null]);
    const result = await pdfExtractor({ data, sourcePath: "/x/scan.pdf" });
    expect(result.pageCount).toBe(3);
    expect(result.textLayer?.status).toBe("scanned");
    expect(result.textLayer?.pagesWithoutText).toEqual([1, 2, 3]);
    expect(result.textLayer?.ocrNeeded).toBe(true);
    expect(result.text.startsWith("This PDF looks scanned: 3 of 3 pages")).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.includes("OCR is needed"))).toBe(true);
  });

  it("flags only the image pages of a mixed PDF", async () => {
    const data = buildPdf([DIGITAL_PAGE, null, DIGITAL_PAGE]);
    const result = await pdfExtractor({ data, sourcePath: "/x/mixed.pdf" });
    expect(result.textLayer?.status).toBe("partial");
    expect(result.textLayer?.pagesWithoutText).toEqual([2]);
    expect(result.text.startsWith("--- page 1 ---")).toBe(true);
    expect(result.text).toContain(DIGITAL_PAGE);
    expect(result.warnings.join("\n")).toContain("pages 2)");
  });

  it("assesses only the requested range", async () => {
    const data = buildPdf([DIGITAL_PAGE, null, null]);
    const result = await pdfExtractor({
      data,
      sourcePath: "/x/mixed.pdf",
      pagesFrom: 2,
      pagesTo: 3,
    });
    expect(result.textLayer?.status).toBe("scanned");
    expect(result.textLayer?.pagesChecked).toBe(2);
    expect(result.textLayer?.pagesWithoutText).toEqual([2, 3]);
  });

  it("hands textless pages to a plugged-in OCR engine", async () => {
    const asked: number[][] = [];
    const engine: OcrEngine = {
      id: "fake-ocr",
      unavailableReason: async () => undefined,
      recognizePdfPages: async (req) => {
        asked.push([...req.pages]);
        return {
          pages: req.pages.map((page) => ({
            page,
            text: `Recognised scan text for page ${page}`,
          })),
          warnings: [],
        };
      },
    };
    const extract = createPdfExtractor({ ocrEngine: engine });
    const data = buildPdf([DIGITAL_PAGE, null]);
    const result = await extract({ data, sourcePath: "/x/mixed.pdf" });
    expect(asked).toEqual([[2]]);
    expect(result.text).toContain("Recognised scan text for page 2");
    expect(result.textLayer?.status).toBe("ok");
    expect(result.textLayer?.ocrEngine).toBe("fake-ocr");
    expect(result.warnings).toEqual([]);
  });
});
