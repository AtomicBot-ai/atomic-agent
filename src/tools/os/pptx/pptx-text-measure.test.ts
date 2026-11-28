import { describe, expect, it } from "vitest";
import { charWidth, textWidthEmu, wrappedLines } from "./pptx-text-measure.js";

/** ATO-2444: slide text measured by width, not counted by characters. */
describe("pptx text measure", () => {
  it("gives wide letters more room than narrow ones, and CJK a whole em", () => {
    expect(charWidth("W")).toBeGreaterThan(charWidth("a"));
    expect(charWidth("a")).toBeGreaterThan(charWidth("i"));
    expect(charWidth("中")).toBe(1000);
    expect(textWidthEmu("WWWW", 24)).toBeGreaterThan(textWidthEmu("iiii", 24) * 3);
    // One em at 10 pt is 10 pt: 127,000 EMU.
    expect(textWidthEmu("中", 10)).toBe(127_000);
  });

  it("wraps words at the width, counts hard breaks, and breaks a word longer than the line", () => {
    const width = textWidthEmu("aaaa aaaa", 20) / 0.92 + 1;
    expect(wrappedLines("aaaa aaaa", width, 20)).toBe(1);
    expect(wrappedLines("aaaa aaaa aaaa", width, 20)).toBe(2);
    expect(wrappedLines("one\ntwo", 10_000_000, 20)).toBe(2);
    expect(wrappedLines("a".repeat(40), (textWidthEmu("a".repeat(10), 20) / 0.92) * 1.0001, 20)).toBe(4);
    expect(wrappedLines("", 10_000_000, 20)).toBe(1);
  });
});
