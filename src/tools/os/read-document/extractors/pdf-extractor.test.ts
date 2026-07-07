import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pdfExtractor } from "./pdf-extractor.js";

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
