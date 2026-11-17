import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { epubExtractor } from "./epub-extractor.js";

const chapter = (title: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>p{color:red}</style></head><body><h1>${title}</h1>${body}</body></html>`;

async function makeEpub(options: { encrypted?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Book</dc:title><dc:creator>Ada Writer</dc:creator></metadata>` +
      `<manifest>` +
      `<item id="c2" href="text/chapter%202.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="css" href="style.css" media-type="text/css"/>` +
      `<item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>` +
      `</manifest><spine><itemref idref="c1"/><itemref idref="css"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`,
  );
  zip.file("OEBPS/style.css", "p { margin: 0 }");
  zip.file(
    "OEBPS/text/ch1.xhtml",
    chapter("Opening", "<p>It was a <em>dark</em> night.</p><ul><li>one</li><li>two</li></ul>"),
  );
  zip.file(
    "OEBPS/text/chapter 2.xhtml",
    chapter("Middle", "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>30</td></tr></table>"),
  );
  zip.file("OEBPS/text/ch3.xhtml", chapter("Ending", "<p>The end.</p>"));
  if (options.encrypted) zip.file("META-INF/encryption.xml", "<encryption/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("epubExtractor", () => {
  it("reads chapters in spine order (not manifest order) as markdown", async () => {
    const result = await epubExtractor({ data: await makeEpub(), sourcePath: "b.epub" });
    expect(result.format).toBe("epub");
    expect(result.pageCount).toBe(3);
    expect(result.pagesExtracted).toEqual([1, 2, 3]);
    expect(result.text.startsWith("# The Test Book\nby Ada Writer")).toBe(true);
    const opening = result.text.indexOf("--- chapter 1 ---");
    const middle = result.text.indexOf("--- chapter 2 ---");
    expect(opening).toBeGreaterThan(-1);
    expect(middle).toBeGreaterThan(opening);
    expect(result.text).toContain("# Opening");
    expect(result.text).toContain("It was a _dark_ night.");
    expect(result.text).toContain("-   one");
    // Percent-encoded href resolves to the file with a space in its name.
    expect(result.text).toContain("| Name | Age |\n| --- | --- |\n| Ann | 30 |");
    // <head> (title, styles) never leaks into the text.
    expect(result.text).not.toContain("color:red");
    expect(result.warnings).toEqual([]);
  });

  it("pages through chapters with pagesFrom/pagesTo and maxPages", async () => {
    const data = await makeEpub();
    const slice = await epubExtractor({ data, sourcePath: "b.epub", pagesFrom: 2, pagesTo: 2 });
    expect(slice.pagesExtracted).toEqual([2]);
    expect(slice.text).toContain("Middle");
    expect(slice.text).not.toContain("Opening");
    // Book title only heads the first slice.
    expect(slice.text).not.toContain("The Test Book");

    const capped = await epubExtractor({ data, sourcePath: "b.epub", maxPages: 2 });
    expect(capped.pagesExtracted).toEqual([1, 2]);
    expect(capped.warnings.join(" ")).toMatch(/1 more chapter/);
  });

  it("warns about DRM when encryption.xml is present", async () => {
    const result = await epubExtractor({
      data: await makeEpub({ encrypted: true }),
      sourcePath: "b.epub",
    });
    expect(result.warnings.join(" ")).toMatch(/DRM/);
  });

  it("explains when the zip is not an EPUB", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "hi");
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const result = await epubExtractor({ data, sourcePath: "b.epub" });
    expect(result.text).toBe("");
    expect(result.warnings.join(" ")).toMatch(/no OPF package/);
  });
});
