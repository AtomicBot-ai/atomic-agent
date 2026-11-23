import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { docxExtractor } from "../read-document/extractors/docx-extractor.js";
import { sniffImage } from "../pptx/pptx-image.js";
import { REVISION_AUTHOR, imageExtent, trackInserted, type Revision } from "./docx-blocks.js";
import { appendToDocx, createDocx } from "./docx-package.js";
import { trackedReplaceInPartXml } from "./docx-replace.js";
import { imagePathsOf, parseBlocks, parseTableBlock } from "./docx-xml.js";

/** A real 1×1 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const DATE = new Date("2026-11-18T09:30:00.000Z");
const rev = (nextId = 1): Revision => ({ author: REVISION_AUTHOR, date: DATE, nextId });

async function parts(data: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

async function text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (file === null) throw new Error(`missing part ${path}`);
  return file.async("text");
}

async function plain(data: Buffer): Promise<string> {
  return (await docxExtractor({ data, sourcePath: "x.docx" })).text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
}

describe("parseBlocks: lists, tables, pictures", () => {
  it("reads list kinds and levels, a picture line and a pipe table", () => {
    const blocks = parseBlocks([
      "1. First\n  - nested bullet\n2) Second",
      "| Name | Qty |\n|---|---:|\n| Pen | 2 |\n| Pad |",
      "![Logo](img/logo.png)",
      "Price | 3 is not a table",
    ]);
    expect(blocks.map((b) => [b.kind, b.level])).toEqual([
      ["numbered", 0],
      ["bullet", 1],
      ["numbered", 0],
      ["table", undefined],
      ["image", undefined],
      ["paragraph", undefined],
    ]);
    expect(blocks[3]!.rows).toEqual([["Name", "Qty"], ["Pen", "2"], ["Pad", ""]]);
    expect(blocks[4]).toMatchObject({ text: "Logo", path: "img/logo.png" });
    expect(imagePathsOf(["![a](x.png)\n![b](x.png)", "text ![c](y.png) inline"])).toEqual(["x.png"]);
  });

  it("keeps an escaped pipe inside a cell and refuses an oversized table", () => {
    expect(parseTableBlock("| a \\| b | c |\n| d | e |")).toEqual([["a | b", "c"], ["d", "e"]]);
    expect(parseTableBlock("| only one line |")).toBeNull();
    const wide = `|${"x|".repeat(21)}\n|${"y|".repeat(21)}`;
    expect(() => parseTableBlock(wide)).toThrow(/at most 20/);
  });
});

describe("createDocx with lists, a table and a picture", () => {
  const blocks = parseBlocks([
    "# Plan",
    "1. Draft\n2. Review\n  - with legal",
    "Then:",
    "1. Ship",
    "- North\n- South",
    "| Item | Cost |\n|---|---|\n| Pens & <ink> | 3 |",
    "![Our logo](logo.png)",
  ]);
  const images = new Map([["logo.png", { data: PNG_1X1, info: sniffImage(PNG_1X1)!, name: "logo.png" }]]);

  it("writes real Word numbering, restarting each numbered list", async () => {
    const zip = await parts(await createDocx(blocks, { images }));
    const numbering = await text(zip, "word/numbering.xml");
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    // Bullets share one list; each numbered run gets its own, from 1.
    expect(numbering.match(/<w:num w:numId=/g)).toHaveLength(3);
    expect(numbering.match(/<w:startOverride w:val="1"\/>/g)).toHaveLength(2);
    // The schema wants every abstractNum before the first num.
    expect(numbering.lastIndexOf("<w:abstractNum ")).toBeLessThan(numbering.indexOf("<w:num "));
    expect(await text(zip, "word/_rels/document.xml.rels")).toContain('Target="numbering.xml"');
    expect(await text(zip, "[Content_Types].xml")).toContain(
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
    );
    const doc = await text(zip, "word/document.xml");
    expect(doc).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>');
    expect(doc).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>');
    expect(doc).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>');
  });

  it("starts a numbered list at the number it was typed with", async () => {
    const blocks = parseBlocks(["1. Intro", "some text", "2. Method\n3. Results", "4. Alone"]);
    expect(blocks.filter((b) => b.kind === "numbered").map((b) => b.start)).toEqual([1, 2, 3, 4]);
    const numbering = await text(await parts(await createDocx(blocks)), "word/numbering.xml");
    // Two runs (the paragraph splits them; the last block joins the second run).
    expect(numbering.match(/<w:startOverride w:val="(\d+)"\/>/g)).toEqual([
      '<w:startOverride w:val="1"/>',
      '<w:startOverride w:val="2"/>',
    ]);
  });

  it("writes a bordered table with a repeating bold header row", async () => {
    const zip = await parts(await createDocx(blocks, { images }));
    const doc = await text(zip, "word/document.xml");
    expect(doc).toContain("<w:tbl><w:tblPr>");
    expect(doc.match(/<w:gridCol /g)).toHaveLength(2);
    expect(doc).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    expect(doc).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Item</w:t>');
    expect(doc).toContain("Pens &amp; &lt;ink&gt;");
  });

  it("embeds the picture as an inline drawing with its media part", async () => {
    const zip = await parts(await createDocx(blocks, { images }));
    expect(zip.file("word/media/image1.png")).not.toBeNull();
    expect(await text(zip, "[Content_Types].xml")).toContain('<Default Extension="png" ContentType="image/png"/>');
    const rels = await text(zip, "word/_rels/document.xml.rels");
    const relId = /Id="(rId\d+)" Type="[^"]+\/image" Target="media\/image1.png"/.exec(rels)?.[1];
    expect(relId).toBeDefined();
    const doc = await text(zip, "word/document.xml");
    expect(doc).toContain(`<a:blip r:embed="${relId}"/>`);
    expect(doc).toContain('descr="Our logo"');
    expect(doc).toContain('<wp:extent cx="9525" cy="9525"/>');
  });

  it("produces only well-formed parts that read back as lists and text", async () => {
    const data = await createDocx(blocks, { images });
    const zip = await parts(data);
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        expect(XMLValidator.validate(await text(zip, name)), name).toBe(true);
      }
    }
    const out = await plain(data);
    expect(out).toMatch(/^1\. Draft/m);
    expect(out).toMatch(/^2\. Review/m);
    expect(out).toMatch(/^1\. Ship/m);
    expect(out).toMatch(/^- North/m);
    expect(out).toContain("Pens & <ink>");
  });

  it("scales a big picture down to the page width, aspect kept", () => {
    expect(imageExtent({ kind: "png", width: 4000, height: 2000 })).toEqual({ cx: 6_120_000, cy: 3_060_000 });
  });
});

describe("appendToDocx into a document that already has lists", () => {
  it("adds its lists after the existing numbering ids", async () => {
    const first = await createDocx(parseBlocks(["1. Old item"]));
    const data = await appendToDocx(first, parseBlocks(["1. New item"]));
    const zip = await parts(data);
    const numbering = await text(zip, "word/numbering.xml");
    expect(numbering.match(/<w:abstractNum /g)).toHaveLength(4);
    expect(numbering).toContain('w:abstractNumId="3"');
    expect(numbering).toContain('<w:num w:numId="4">');
    expect(numbering.lastIndexOf("<w:abstractNum ")).toBeLessThan(numbering.indexOf("<w:num "));
    expect(XMLValidator.validate(numbering)).toBe(true);
    expect((await text(zip, "word/_rels/document.xml.rels")).match(/numbering\.xml/g)).toHaveLength(1);
  });

  it("marks an appended block as one tracked insertion by Atomic Agent", async () => {
    const base = await createDocx(parseBlocks(["Existing text."]));
    const data = await appendToDocx(base, parseBlocks(["Added **line**", "| a | b |\n| c | d |"]), { revision: rev() });
    const doc = await text(await parts(data), "word/document.xml");
    expect(XMLValidator.validate(doc)).toBe(true);
    expect(doc).toContain('w:author="Atomic Agent" w:date="2026-11-18T09:30:00Z"');
    expect(doc).toMatch(/<w:ins w:id="\d+" [^>]*><w:r><w:t xml:space="preserve">Added <\/w:t><\/w:r><\/w:ins>/);
    expect(doc).toMatch(/<w:trPr><w:ins [^>]*\/><\/w:trPr>/);
    expect(doc).toMatch(/<w:pPr><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr>/);
    // The text that was there is not marked.
    expect(doc).toMatch(/<w:p><w:r><w:t xml:space="preserve">Existing text\.<\/w:t><\/w:r><\/w:p>/);
    const ids = [...doc.matchAll(/<w:ins w:id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("trackInserted flags a list paragraph's mark after its numbering", () => {
    const xml = trackInserted('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>', rev(7));
    expect(xml).toBe(
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:rPr><w:ins w:id="8" w:author="Atomic Agent" w:date="2026-11-18T09:30:00Z"/></w:rPr></w:pPr>' +
        '<w:ins w:id="7" w:author="Atomic Agent" w:date="2026-11-18T09:30:00Z"><w:r><w:t>x</w:t></w:r></w:ins></w:p>',
    );
  });
});

describe("trackedReplaceInPartXml", () => {
  const para = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;

  it("writes the old text as a deletion and the new as an insertion, keeping the run's formatting", () => {
    const src = para('<w:r><w:rPr><w:b/></w:rPr><w:t>Hello world</w:t></w:r>');
    const { xml, count } = trackedReplaceInPartXml(src, "world", "there", Infinity, rev(10));
    expect(count).toBe(1);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toBe(
      "<w:p>" +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>' +
        '<w:del w:id="10" w:author="Atomic Agent" w:date="2026-11-18T09:30:00Z"><w:r><w:rPr><w:b/></w:rPr><w:delText xml:space="preserve">world</w:delText></w:r></w:del>' +
        '<w:ins w:id="11" w:author="Atomic Agent" w:date="2026-11-18T09:30:00Z"><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">there</w:t></w:r></w:ins>' +
        "</w:p>",
    );
  });

  it("tracks a match Word split across runs, and an empty replacement as a deletion only", () => {
    const src = para('<w:r w:rsidR="1"><w:t>quar</w:t></w:r>', "<w:r><w:t>terly report</w:t></w:r>");
    const { xml, count } = trackedReplaceInPartXml(src, "quarterly", "annual", Infinity, rev());
    expect(count).toBe(1);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('<w:r w:rsidR="1"><w:delText xml:space="preserve">quar</w:delText></w:r></w:del>');
    expect(xml).toContain('<w:r w:rsidR="1"><w:t xml:space="preserve">annual</w:t></w:r></w:ins>');
    expect(xml).toContain('<w:r><w:delText xml:space="preserve">terly</w:delText></w:r></w:del>');
    expect(xml).toContain('<w:r><w:t xml:space="preserve"> report</w:t></w:r>');

    const gone = trackedReplaceInPartXml(para("<w:r><w:t>x1x2</w:t></w:r>"), "x", "", Infinity, rev());
    expect(gone.count).toBe(2);
    expect(gone.xml).not.toContain("<w:ins");
    expect(gone.xml.match(/<w:del /g)).toHaveLength(2);
    expect(gone.xml).toContain(">1</w:t>");
    expect(gone.xml).toContain(">2</w:t>");
  });

  it("respects the limit and gives every mark its own id", () => {
    const src = para("<w:r><w:t>a-a-a</w:t></w:r>");
    const first = trackedReplaceInPartXml(src, "a", "b", 1, rev());
    expect(first.count).toBe(1);
    expect(first.xml.match(/<w:del /g)).toHaveLength(1);
    const all = trackedReplaceInPartXml(src, "a", "b", Infinity, rev());
    const ids = [...all.xml.matchAll(/w:id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});
