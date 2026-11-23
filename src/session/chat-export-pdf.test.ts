import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodeWinAnsi, renderMarkdownPdf } from "./chat-export-pdf.js";

/** Every page's content stream, inflated, as latin1 text. */
function pageStreams(pdf: Buffer): string[] {
  const text = pdf.toString("latin1");
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    out.push(inflateSync(pdf.subarray(start, start + Number(m[1]))).toString("latin1"));
  }
  return out;
}

/** The words a reader sees: strings within one text object joined, objects joined by a space. */
function shownText(stream: string): string {
  return (stream.match(/BT [\s\S]*? ET/g) ?? [])
    .map((obj) => (obj.match(/\(((?:\\.|[^\\)])*)\) Tj/g) ?? []).map((tj) => tj.slice(1, -4)).join(""))
    .join(" ");
}

describe("chat export to PDF (ATO-1054)", () => {
  it("writes a header, objects at the offsets the xref lists, and a trailer", () => {
    const pdf = renderMarkdownPdf("# Hello\n\nWorld", "My chat", Date.UTC(2026, 10, 12));
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 5)).toBe("xref\n");
    const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text.slice(startxref));
    expect(xref).not.toBeNull();
    const count = Number(xref![1]);
    const entries = xref![2]!.match(/.{20}/gs) ?? [];
    expect(entries).toHaveLength(count);
    expect(entries[0]).toBe("0000000000 65535 f \n");
    entries.slice(1).forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain(`/Size ${count} /Root 1 0 R /Info 7 0 R`);
    expect(text).toContain("/BaseFont /Helvetica /Encoding /WinAnsiEncoding");
    expect(text).toContain("/CreationDate (D:20261112000000Z)");
    // The title keeps any character: UTF-16BE with a byte order mark.
    expect(text).toContain("/Title <FEFF004D007900200063006800610074>");
  });

  it("draws the text and numbers one page for a short chat", () => {
    const pdf = renderMarkdownPdf("## You\n\nWhat is **Lisbon** like in `May`?", "Trip");
    expect(pdf.toString("latin1")).toMatch(/\/Type \/Pages \/Kids \[8 0 R\] \/Count 1/);
    const [page] = pageStreams(pdf);
    expect(page).toContain("(You) Tj");
    expect(page).toContain("(Lisbon) Tj");
    expect(page).toContain("/F2 "); // bold
    expect(page).toContain("/F4 "); // code in Courier
    expect(page).toContain("(Page 1 of 1) Tj");
  });

  it("starts new pages for a long chat and counts them in the page tree", () => {
    const long = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1} of a long reply.`).join("\n\n");
    const pdf = renderMarkdownPdf(long, "Long");
    const pages = pageStreams(pdf);
    expect(pages.length).toBeGreaterThan(3);
    const tree = /\/Type \/Pages \/Kids \[([^\]]*)\] \/Count (\d+)/.exec(pdf.toString("latin1"));
    expect(Number(tree![2])).toBe(pages.length);
    expect(tree![1]!.split(" 0 R").filter((s) => s.trim()).length).toBe(pages.length);
    expect((pdf.toString("latin1").match(/\/Type \/Page /g) ?? []).length).toBe(pages.length);
    expect(pages[pages.length - 1]).toContain(`(Page ${pages.length} of ${pages.length}) Tj`);
    expect(pages.join("\n")).toContain("(Paragraph 300 of a long reply.) Tj");
  });

  it("wraps long lines inside the margins and escapes PDF string syntax", () => {
    const pdf = renderMarkdownPdf(`${"word ".repeat(200)}\n\nA (paren) and a \\ backslash`, "Wrap");
    const page = pageStreams(pdf)[0]!;
    const lines = page.match(/\(word[^)]*\) Tj/g) ?? [];
    expect(lines.length).toBeGreaterThan(5);
    expect(page).toContain("(A \\(paren\\) and a \\\\ backslash) Tj");
  });

  it("transliterates or replaces what WinAnsi lacks, and says so at the end", () => {
    expect(encodeWinAnsi("Café “quoted” — €5")).toEqual({
      text: "Café \u0093quoted\u0094 \u0097 \u00805",
      changed: 0,
    });
    expect(encodeWinAnsi("Привет")).toEqual({ text: "Privet", changed: 6 });
    expect(encodeWinAnsi("a → b")).toEqual({ text: "a -> b", changed: 1 });
    expect(encodeWinAnsi("łódź")).toEqual({ text: "lódz", changed: 2 });
    expect(encodeWinAnsi("你好 🚀")).toEqual({ text: "?? ?", changed: 3 });
    expect(encodeWinAnsi("zero​width️")).toEqual({ text: "zerowidth", changed: 0 });

    const clean = pageStreams(renderMarkdownPdf("Plain English.", "Clean")).join("\n");
    expect(clean).not.toContain("standard PDF fonts");
    const mixed = pageStreams(renderMarkdownPdf("Привет 你", "Mixed")).join("\n");
    expect(mixed).toContain("(Privet ?) Tj");
    expect(shownText(mixed)).toContain("7 characters were transliterated or shown as \"?\"");
  });

  it("keeps lists, code blocks, quotes and tables as text", () => {
    const pdf = renderMarkdownPdf(
      ["- one", "- [x] done", "", "1. first", "", "> quoted", "", "```", "  indented()", "```", "", "| A | B |", "|---|---|", "| 1 | 2 |"].join("\n"),
      "Blocks",
    );
    const page = pageStreams(pdf)[0]!;
    expect(page).toContain("(\u0095) Tj"); // the bullet, in WinAnsi
    expect(page).toContain("([x]) Tj");
    expect(page).toContain("(1.) Tj");
    expect(page).toContain("(quoted) Tj");
    expect(page).toContain("(  indented\\(\\)) Tj");
    expect(page).toMatch(/\(A\) Tj .*\( \| \) Tj .*\(B\) Tj/);
  });
});
