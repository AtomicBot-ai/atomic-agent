import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { odsExtractor } from "./ods-extractor.js";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

async function makeOds(tablesXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet");
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body><office:spreadsheet>${tablesXml}</office:spreadsheet></office:body></office:document-content>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const cell = (text: string, attrs = "") =>
  `<table:table-cell${attrs}><text:p>${text}</text:p></table:table-cell>`;
const empty = (repeat: number) =>
  `<table:table-cell table:number-columns-repeated="${repeat}"/>`;

describe("odsExtractor", () => {
  it("renders each sheet as pipe rows, like the XLSX extractor", async () => {
    const data = await makeOds(
      `<table:table table:name="Revenue">` +
        `<table:table-row>${cell("Quarter")}${cell("Amount")}${empty(16382)}</table:table-row>` +
        `<table:table-row>${cell("Q1")}${cell("1200", ' office:value-type="float" office:value="1200"')}</table:table-row>` +
        `<table:table-row table:number-rows-repeated="1048574">${empty(16384)}</table:table-row>` +
        `</table:table>` +
        `<table:table table:name="Notes"><table:table-row>${cell("hello")}</table:table-row></table:table>`,
    );
    const result = await odsExtractor({ data, sourcePath: "x.ods" });
    expect(result.format).toBe("ods");
    expect(result.sheetCount).toBe(2);
    expect(result.pagesExtracted).toEqual([1, 2]);
    expect(result.text).toBe(
      "## Sheet: Revenue\n\nQuarter | Amount\nQ1 | 1200\n\n## Sheet: Notes\n\nhello",
    );
    expect(result.warnings).toEqual([]);
  });

  it("keeps cell text verbatim (leading zeros, exponent-looking ids)", async () => {
    const data = await makeOds(
      `<table:table table:name="S"><table:table-row>${cell("007")}${cell("1e5")}${cell("a&amp;b")}</table:table-row></table:table>`,
    );
    const result = await odsExtractor({ data, sourcePath: "x.ods" });
    expect(result.text).toContain("007 | 1e5 | a&b");
  });

  it("keeps inner gaps, expands repeated values and handles ODF spaces", async () => {
    const data = await makeOds(
      `<table:table table:name="S"><table:table-row>` +
        `${cell("a")}${empty(2)}${cell("x", ' table:number-columns-repeated="2"')}` +
        `<table:table-cell><text:p>two<text:s text:c="2"/>spaces</text:p></table:table-cell>` +
        `</table:table-row></table:table>`,
    );
    const result = await odsExtractor({ data, sourcePath: "x.ods" });
    expect(result.text).toContain("a |  |  | x | x | two  spaces");
  });

  it("selects sheets by name or 1-indexed position and warns on unknown ones", async () => {
    const data = await makeOds(
      `<table:table table:name="One"><table:table-row>${cell("first")}</table:table-row></table:table>` +
        `<table:table table:name="Two"><table:table-row>${cell("second")}</table:table-row></table:table>`,
    );
    const byName = await odsExtractor({ data, sourcePath: "x.ods", sheets: ["two"] });
    expect(byName.text).toBe("## Sheet: Two\n\nsecond");
    expect(byName.pagesExtracted).toEqual([2]);

    const byIndex = await odsExtractor({ data, sourcePath: "x.ods", sheets: [1, "Missing"] });
    expect(byIndex.text).toContain("first");
    expect(byIndex.text).not.toContain("second");
    expect(byIndex.warnings).toContain('sheet "Missing" not found');
  });

  it("returns a warning when content.xml is missing", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet");
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const result = await odsExtractor({ data, sourcePath: "x.ods" });
    expect(result.text).toBe("");
    expect(result.warnings).toContain("content.xml missing");
  });
});
