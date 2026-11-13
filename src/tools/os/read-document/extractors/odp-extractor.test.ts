import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { odpExtractor } from "./odp-extractor.js";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

const slide = (name: string, inner: string) =>
  `<draw:page draw:name="${name}">${inner}</draw:page>`;
const frame = (...paragraphs: string[]) =>
  `<draw:frame><draw:text-box>${paragraphs.map((p) => `<text:p>${p}</text:p>`).join("")}</draw:text-box></draw:frame>`;

async function makeOdp(pages: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.presentation");
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body><office:presentation>${pages.join("")}</office:presentation></office:body></office:document-content>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("odpExtractor", () => {
  const deck = () =>
    makeOdp([
      slide(
        "p1",
        frame("Slide One") +
          `<draw:frame><draw:text-box><text:list><text:list-item><text:p>First bullet</text:p></text:list-item></text:list></draw:text-box></draw:frame>` +
          `<presentation:notes>${frame("Speaker notes stay out")}</presentation:notes>`,
      ),
      slide(
        "p2",
        frame("Slide Two") +
          `<draw:frame><table:table><table:table-row><table:table-cell><text:p>k</text:p></table:table-cell><table:table-cell><text:p>v</text:p></table:table-cell></table:table-row></table:table></draw:frame>`,
      ),
      slide("p3", frame("Slide Three")),
    ]);

  it("extracts slides in order with `--- slide N ---` separators", async () => {
    const result = await odpExtractor({ data: await deck(), sourcePath: "x.odp" });
    expect(result.format).toBe("odp");
    expect(result.slideCount).toBe(3);
    expect(result.pagesExtracted).toEqual([1, 2, 3]);
    expect(result.text).toContain("--- slide 1 ---\nSlide One\nFirst bullet");
    expect(result.text).toContain("--- slide 2 ---\nSlide Two\nk | v");
    expect(result.text).not.toContain("Speaker notes");
    expect(result.warnings).toEqual([]);
  });

  it("honours pagesFrom/pagesTo and maxPages", async () => {
    const data = await deck();
    const range = await odpExtractor({ data, sourcePath: "x.odp", pagesFrom: 2, pagesTo: 2 });
    expect(range.pagesExtracted).toEqual([2]);
    expect(range.text).toContain("Slide Two");
    expect(range.text).not.toContain("Slide One");

    const capped = await odpExtractor({ data, sourcePath: "x.odp", maxPages: 1 });
    expect(capped.pagesExtracted).toEqual([1]);
    expect(capped.warnings.join(" ")).toMatch(/maxPages=1/);
  });

  it("warns when the deck has no slides", async () => {
    const result = await odpExtractor({ data: await makeOdp([]), sourcePath: "x.odp" });
    expect(result.slideCount).toBe(0);
    expect(result.warnings).toContain("no slides found");
  });
});
