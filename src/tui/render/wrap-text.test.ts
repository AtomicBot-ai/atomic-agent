import { describe, expect, it } from "vitest";
import { expandTabs, wrapText } from "./wrap-text.js";

describe("wrapText", () => {
  it("returns the text as one row when it already fits", () => {
    expect(wrapText("hello", 80)).toEqual(["hello"]);
  });

  it("preserves explicit hard breaks", () => {
    expect(wrapText("a\nb\nc", 80)).toEqual(["a", "b", "c"]);
  });

  it("turns an empty paragraph into an empty row", () => {
    expect(wrapText("first\n\nsecond", 80)).toEqual(["first", "", "second"]);
  });

  it("soft-wraps at the last word boundary inside the budget", () => {
    expect(wrapText("alpha bravo charlie delta", 11)).toEqual([
      "alpha bravo",
      "charlie",
      "delta",
    ]);
  });

  it("hard-cuts when no word boundary fits before the budget", () => {
    const long = "abcdefghij".repeat(3);
    expect(wrapText(long, 10)).toEqual([
      "abcdefghij",
      "abcdefghij",
      "abcdefghij",
    ]);
  });

  it("falls back to newline-only split when width is non-positive", () => {
    expect(wrapText("a b c\nd", 0)).toEqual(["a b c", "d"]);
  });

  it("preserves CRLF line endings", () => {
    expect(wrapText("a\r\nb", 80)).toEqual(["a", "b"]);
  });
});

describe("tabs are expanded to what the terminal draws", () => {
  it("counts a tab as its columns, not as one character", () => {
    // git indents its file lists with a tab. Measured as one column the
    // row fits; drawn as eight it overflows, and the terminal clips the
    // overflow — which cost every path its last character in the field.
    const line =
      "\tsrc/tui/components/local-models/download-progress-strip.tsx";
    expect(line.length).toBe(60);
    const rows = wrapText(line, 64);
    // 8 columns of tab + 59 of path = 67, past the 64 it was given.
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(64);
    // Nothing is lost — the last character is still there.
    expect(rows.join("")).toContain(".tsx");
  });

  it("expands to the next tab stop, not by a fixed eight", () => {
    expect(expandTabs("ab\tc")).toBe("ab      c");
    expect(expandTabs("\tx")).toBe("        x");
    expect(expandTabs("12345678\ty")).toBe("12345678        y");
  });

  it("leaves a line without tabs exactly as it was", () => {
    const plain = "error: Your local changes would be overwritten";
    expect(expandTabs(plain)).toBe(plain);
  });
});
