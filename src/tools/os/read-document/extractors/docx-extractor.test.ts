import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { docxExtractor } from "./docx-extractor.js";

const FIXTURE_PATH = resolve(
  new URL("../../test-fixtures/sample.docx", import.meta.url).pathname,
);

describe("docxExtractor", () => {
  it("extracts headings as markdown with body paragraphs", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("docx");
    // mammoth maps Heading 1 → #, Heading 2 → ##
    expect(result.text).toMatch(/^# Document Title/m);
    expect(result.text).toMatch(/^## Introduction/m);
    expect(result.text).toMatch(/sacred rites of the Omnissiah/);
    expect(result.text).toMatch(/Second paragraph: all systems nominal/);
  });

  it("returns raw text (no markdown) when includeTables=false", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      includeTables: false,
    });
    expect(result.text).not.toMatch(/^#/m);
    expect(result.text).toContain("Document Title");
    expect(result.text).toContain("Introduction");
  });

  it("collects mammoth warnings/errors into warnings[]", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({ data, sourcePath: FIXTURE_PATH });
    // Warnings may or may not be empty depending on the fixture; the contract
    // is simply that it's an array.
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
