import { describe, expect, it } from "vitest";
import { wrapText } from "./wrap-text.js";

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
