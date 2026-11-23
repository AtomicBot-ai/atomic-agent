import { describe, expect, it } from "vitest";

import { CHUNK_TARGET_CHARS, chunkSegments, pageSegments, splitText } from "./file-chunker.js";

describe("pageSegments: the PDF extractor's dividers become pages", () => {
  it("keeps each page's number and drops empty pages and a leading notice", () => {
    const text = [
      "This PDF is partly scanned.",
      "",
      "--- page 1 ---",
      "Intro text.",
      "",
      "--- page 2 ---",
      "",
      "--- page 3 ---",
      "Termination needs 30 days notice.",
    ].join("\n");
    expect(pageSegments(text)).toEqual([
      { text: "Intro text.", page: 1 },
      { text: "Termination needs 30 days notice.", page: 3 },
    ]);
  });

  it("is one segment without a page when there are no dividers", () => {
    expect(pageSegments("plain words")).toEqual([{ text: "plain words" }]);
    expect(pageSegments("   ")).toEqual([]);
  });
});

describe("chunkSegments: ~1000 characters, never across a page", () => {
  it("numbers chunks in file order and keeps the page on each", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about the contract terms.`).join(" ");
    const chunks = chunkSegments([
      { text: long, page: 4 },
      { text: "Short page.", page: 5 },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
    const last = chunks[chunks.length - 1]!;
    expect(last).toEqual({ ord: chunks.length - 1, page: 5, text: "Short page." });
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.page).toBe(4);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
    // Nothing is lost but the whitespace at the cuts.
    const joined = chunks.slice(0, -1).map((c) => c.text).join(" ");
    expect(joined.replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });

  it("carries a time offset and leaves page out when there is none", () => {
    expect(chunkSegments([{ text: "hello", timeSec: 83 }])).toEqual([{ ord: 0, timeSec: 83, text: "hello" }]);
    expect(chunkSegments([{ text: "hello" }])).toEqual([{ ord: 0, text: "hello" }]);
  });
});

describe("splitText", () => {
  it("prefers a paragraph break, then a sentence end, then a space", () => {
    const paragraph = `${"a".repeat(700)}\n\n${"b".repeat(500)}`;
    expect(splitText(paragraph)).toEqual(["a".repeat(700), "b".repeat(500)]);
    const sentences = `${"word ".repeat(140)}end. ${"next ".repeat(80)}`;
    const pieces = splitText(sentences);
    expect(pieces[0]!.endsWith("end.")).toBe(true);
  });

  it("cuts a text with no breaks at the target", () => {
    const pieces = splitText("x".repeat(2500));
    expect(pieces.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });

  it("returns nothing for blank text", () => {
    expect(splitText(" \n\n ")).toEqual([]);
  });
});
