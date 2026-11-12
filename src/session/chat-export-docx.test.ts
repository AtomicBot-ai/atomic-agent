import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { markdownToDocumentXml, renderMarkdownDocx } from "./chat-export-docx.js";

describe("chat export to DOCX (ATO-1054)", () => {
  it("packs the parts Word needs to open the file", async () => {
    const buf = await renderMarkdownDocx("# Hello\n\nWorld", "My <chat>", Date.UTC(2026, 10, 12));
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    const zip = await JSZip.loadAsync(buf);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/document.xml"]) {
      expect(zip.file(part), part).not.toBeNull();
    }
    const types = await zip.file("[Content_Types].xml")!.async("string");
    expect(types).toContain('PartName="/word/document.xml"');
    const core = await zip.file("docProps/core.xml")!.async("string");
    expect(core).toContain("<dc:title>My &lt;chat&gt;</dc:title>");
    expect(core).toContain("2026-11-12T00:00:00Z");
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc).toContain(">Hello</w:t>");
    expect(doc).toContain(">World</w:t>");
  });

  it("keeps bold, code, lists and tables, and escapes XML", () => {
    const xml = markdownToDocumentXml(
      [
        "Some **bold** and `a < b` & more\u0007",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```",
        "line1",
        "line2",
        "```",
      ].join("\n"),
    );
    expect(xml).toContain("<w:b/></w:rPr><w:t xml:space=\"preserve\">bold</w:t>");
    expect(xml).toContain("a &lt; b");
    expect(xml).toContain("&amp; more");
    expect(xml).not.toContain("\u0007");
    expect(xml).toContain("• </w:t>");
    expect(xml).toContain(">1. </w:t>");
    expect(xml).toContain(">2. </w:t>");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("line1</w:t><w:br/><w:t xml:space=\"preserve\">line2");
  });

  it("writes link addresses after the text and task markers once", () => {
    const xml = markdownToDocumentXml("[site](https://example.com)\n\n- [x] done\n- [ ] todo");
    expect(xml).toContain(" (https://example.com)");
    expect(xml.match(/\[x\] /g)).toHaveLength(1);
    expect(xml.match(/\[ \] /g)).toHaveLength(1);
  });
});
