import { describe, expect, it } from "vitest";

import { replaceInPartXml } from "./docx-replace.js";
import { insertAtBodyEnd } from "./docx-package.js";
import { paragraphXml, parseBlocks } from "./docx-xml.js";

const para = (...runs: string[]): string =>
  `<w:p>${runs.map((r) => `<w:r><w:t>${r}</w:t></w:r>`).join("")}</w:p>`;

describe("replaceInPartXml", () => {
  it("replaces text inside one run and marks the run space-preserving", () => {
    const { xml, count } = replaceInPartXml(para("Hello world"), "world", "there", Infinity);
    expect(count).toBe(1);
    expect(xml).toBe('<w:p><w:r><w:t xml:space="preserve">Hello there</w:t></w:r></w:p>');
  });

  it("matches across runs Word split, keeping the first run's formatting", () => {
    const src =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>quar</w:t></w:r><w:r><w:t>terly</w:t></w:r><w:r><w:t xml:space="preserve"> report</w:t></w:r></w:p>';
    const { xml, count } = replaceInPartXml(src, "quarterly rep", "annual rep", Infinity);
    expect(count).toBe(1);
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">annual rep</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve"></w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">ort</w:t>');
  });

  it("never matches across two paragraphs", () => {
    const { count } = replaceInPartXml(para("end of one") + para("two starts"), "one two", "x", Infinity);
    expect(count).toBe(0);
  });

  it("respects the limit and counts every occurrence otherwise", () => {
    const src = para("a-a-a") + para("a");
    expect(replaceInPartXml(src, "a", "b", Infinity).count).toBe(4);
    const first = replaceInPartXml(src, "a", "b", 1);
    expect(first.count).toBe(1);
    expect(first.xml).toContain(">b-a-a<");
  });

  it("decodes and re-escapes XML entities", () => {
    const { xml, count } = replaceInPartXml(para("R&amp;D &lt;draft&gt;"), "<draft>", "& final", Infinity);
    expect(count).toBe(1);
    expect(xml).toContain(">R&amp;D &amp; final<");
  });

  it("handles several matches in one run and an empty replacement", () => {
    const { xml, count } = replaceInPartXml(para("x1x2x"), "x", "", Infinity);
    expect(count).toBe(3);
    expect(xml).toContain(">12<");
  });

  it("does not treat <w:tab/> or <w:pPr> as text or paragraph tokens", () => {
    const src = '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>left</w:t><w:tab/><w:t>right</w:t></w:r></w:p>';
    const { xml, count } = replaceInPartXml(src, "right", "RIGHT", Infinity);
    expect(count).toBe(1);
    expect(xml).toContain("<w:tab/>");
    expect(xml).toContain(">RIGHT<");
  });
});

describe("blocks and body insertion", () => {
  it("parses headings, bullets, bold and line breaks", () => {
    expect(parseBlocks(["# Title", "## Sub\n- item", "plain"]).map((b) => b.kind)).toEqual([
      "heading1",
      "heading2",
      "bullet",
      "paragraph",
    ]);
    expect(paragraphXml({ kind: "paragraph", text: "a **b** <c>" })).toBe(
      '<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">b</w:t></w:r><w:r><w:t xml:space="preserve"> &lt;c&gt;</w:t></w:r></w:p>',
    );
    expect(paragraphXml({ kind: "heading1", text: "T" })).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it("inserts before the body-level sectPr, not a section break inside a paragraph", () => {
    const doc =
      '<w:document><w:body><w:p><w:pPr><w:sectPr><w:cols/></w:sectPr></w:pPr></w:p><w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>';
    const out = insertAtBodyEnd(doc, "<NEW/>");
    expect(out).toContain("</w:p><NEW/><w:sectPr><w:pgSz/>");
  });

  it("inserts before </w:body> when there is no body-level sectPr", () => {
    const doc = '<w:document><w:body><w:p><w:pPr><w:sectPr/></w:pPr></w:p></w:body></w:document>';
    expect(insertAtBodyEnd(doc, "<NEW/>")).toContain("</w:p><NEW/></w:body>");
  });
});
