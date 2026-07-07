import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pptxExtractor } from "./pptx-extractor.js";

const FIXTURE_PATH = resolve(
  fileURLToPath(new URL("../../test-fixtures/sample.pptx", import.meta.url)),
);

describe("pptxExtractor", () => {
  it("extracts both slides with `--- slide N ---` separators", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pptxExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("pptx");
    expect(result.slideCount).toBe(2);
    expect(result.pagesExtracted).toEqual([1, 2]);
    expect(result.text).toContain("--- slide 1 ---");
    expect(result.text).toContain("--- slide 2 ---");
    expect(result.text).toContain("Slide One");
    expect(result.text).toContain("First slide body content.");
    expect(result.text).toContain("Slide Two");
    expect(result.text).toContain("Second slide body content.");
  });

  it("honours pagesFrom/pagesTo", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pptxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      pagesFrom: 2,
      pagesTo: 2,
    });
    expect(result.pagesExtracted).toEqual([2]);
    expect(result.text).toContain("Slide Two");
    expect(result.text).not.toContain("Slide One");
  });

  it("honours maxPages cap", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pptxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      maxPages: 1,
    });
    expect(result.pagesExtracted).toEqual([1]);
  });

  it("omits separators when pageSeparators=false", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await pptxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      pageSeparators: false,
    });
    expect(result.text).not.toContain("--- slide");
  });
});
