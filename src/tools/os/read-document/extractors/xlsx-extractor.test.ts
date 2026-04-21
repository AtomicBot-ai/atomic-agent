import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { xlsxExtractor } from "./xlsx-extractor.js";

const FIXTURE_PATH = resolve(
  new URL("../../test-fixtures/sample.xlsx", import.meta.url).pathname,
);

describe("xlsxExtractor", () => {
  it("renders both sheets with headers and pipe-separated rows", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await xlsxExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("xlsx");
    expect(result.sheetCount).toBe(2);
    expect(result.pagesExtracted).toEqual([1, 2]);
    expect(result.text).toContain("## Sheet: Revenue");
    expect(result.text).toContain("Quarter | Amount | Notes");
    expect(result.text).toContain("Q1 | 1200 | Good");
    expect(result.text).toContain("Q2 | 1500 | Better");
    expect(result.text).toContain("## Sheet: Notes");
    expect(result.text).toContain("Blessing | Complete");
    expect(result.warnings).toEqual([]);
  });

  it("filters to a named sheet via `sheets`", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await xlsxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      sheets: ["Notes"],
    });
    expect(result.pagesExtracted).toEqual([2]);
    expect(result.text).toContain("## Sheet: Notes");
    expect(result.text).not.toContain("Revenue");
  });

  it("filters to a sheet by 1-indexed position", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await xlsxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      sheets: [1],
    });
    expect(result.pagesExtracted).toEqual([1]);
    expect(result.text).toContain("Revenue");
    expect(result.text).not.toContain("## Sheet: Notes");
  });

  it("warns when a requested sheet is missing", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await xlsxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      sheets: ["NonExistent", 99],
    });
    expect(result.warnings).toContain('sheet "NonExistent" not found');
    expect(result.warnings).toContain("sheet index 99 is out of range");
    expect(result.text).toBe("");
  });

  it("omits sheet headers when pageSeparators=false", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await xlsxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      pageSeparators: false,
    });
    expect(result.text).not.toContain("## Sheet:");
    expect(result.text).toContain("Q1 | 1200 | Good");
  });
});
