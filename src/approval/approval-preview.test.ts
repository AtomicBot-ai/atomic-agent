import { describe, expect, it } from "vitest";

import {
  excerptPreview,
  hiddenLinesNote,
  previewLines,
} from "./approval-preview.js";

const SCRIPT = "echo hi\nmkdir -p out\nrm -rf out/cache";

describe("excerptPreview (ATO-434)", () => {
  it("shows every line of a command that fits", () => {
    expect(excerptPreview(SCRIPT, { maxLines: 20, maxChars: 1000 })).toEqual({
      lines: ["echo hi", "mkdir -p out", "rm -rf out/cache"],
      hiddenLines: 0,
    });
  });

  it("keeps whole lines and counts the rest when the line cap is hit", () => {
    expect(excerptPreview(SCRIPT, { maxLines: 2, maxChars: 1000 })).toEqual({
      lines: ["echo hi", "mkdir -p out"],
      hiddenLines: 1,
    });
  });

  it("stops at a whole line when the character budget is hit", () => {
    // "echo hi\nmkdir -p out" is 20 characters; the third line does not fit.
    expect(excerptPreview(SCRIPT, { maxLines: 20, maxChars: 25 })).toEqual({
      lines: ["echo hi", "mkdir -p out"],
      hiddenLines: 1,
    });
  });

  it("cuts a single line longer than the budget and marks the cut", () => {
    const long = "x".repeat(50);
    const excerpt = excerptPreview(`${long}\nsecond`, { maxLines: 20, maxChars: 10 });
    expect(excerpt.lines).toEqual([`${"x".repeat(9)}…`]);
    expect(excerpt.hiddenLines).toBe(1);
  });

  it("reads CRLF line endings as line breaks", () => {
    expect(previewLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
  });
});

describe("hiddenLinesNote", () => {
  it("says how many lines are not shown", () => {
    expect(hiddenLinesNote(0)).toBeNull();
    expect(hiddenLinesNote(1)).toBe("… +1 more line");
    expect(hiddenLinesNote(12)).toBe("… +12 more lines");
  });
});
