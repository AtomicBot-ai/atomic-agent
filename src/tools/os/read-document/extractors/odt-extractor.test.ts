import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { odtExtractor } from "./odt-extractor.js";

const FIXTURE_PATH = resolve(
  new URL("../../test-fixtures/sample.odt", import.meta.url).pathname,
);

describe("odtExtractor", () => {
  it("extracts a heading with markdown prefix and paragraphs", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await odtExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("odt");
    expect(result.text).toMatch(/^# ODT Title/m);
    expect(result.text).toContain("First paragraph of the ODT fixture.");
    expect(result.text).toContain("the sacred circuits hum");
    expect(result.warnings).toEqual([]);
  });

  it("returns a warning when content.xml is missing", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.text");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const result = await odtExtractor({ data: buf, sourcePath: "x.odt" });
    expect(result.text).toBe("");
    expect(result.warnings).toContain("content.xml missing");
  });
});
