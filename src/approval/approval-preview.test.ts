import { describe, expect, it } from "vitest";

import {
  excerptPreview,
  hiddenLinesNote,
  isPreviewCut,
  pagePreview,
  previewLines,
} from "./approval-preview.js";

const SCRIPT = "echo hi\nmkdir -p out\nrm -rf out/cache";

describe("excerptPreview (ATO-434)", () => {
  it("shows every line of a command that fits", () => {
    expect(excerptPreview(SCRIPT, { maxLines: 20, maxChars: 1000 })).toEqual({
      lines: ["echo hi", "mkdir -p out", "rm -rf out/cache"],
      hiddenLines: 0,
      cutChars: 0,
    });
  });

  it("keeps whole lines and counts the rest when the line cap is hit", () => {
    expect(excerptPreview(SCRIPT, { maxLines: 2, maxChars: 1000 })).toEqual({
      lines: ["echo hi", "mkdir -p out"],
      hiddenLines: 1,
      cutChars: 0,
    });
  });

  it("stops at a whole line when the character budget is hit", () => {
    // "echo hi\nmkdir -p out" is 20 characters; the third line does not fit.
    expect(excerptPreview(SCRIPT, { maxLines: 20, maxChars: 25 })).toEqual({
      lines: ["echo hi", "mkdir -p out"],
      hiddenLines: 1,
      cutChars: 0,
    });
  });

  it("cuts a single line longer than the budget and marks the cut", () => {
    const long = "x".repeat(50);
    const excerpt = excerptPreview(`${long}\nsecond`, { maxLines: 20, maxChars: 10 });
    expect(excerpt.lines).toEqual([`${"x".repeat(9)}…`]);
    expect(excerpt.hiddenLines).toBe(1);
    expect(excerpt.cutChars).toBe(41);
  });

  it("says how much of a padded one-liner is cut, so the tail is not silently lost", () => {
    const padded = `echo ${" ".repeat(1200)}; rm -rf ~`;
    const excerpt = excerptPreview(padded, { maxLines: 20, maxChars: 1200 });
    expect(excerpt.hiddenLines).toBe(0);
    expect(excerpt.cutChars).toBe(padded.length - 1199);
    expect(hiddenLinesNote(excerpt.hiddenLines, excerpt.cutChars)).toBe(
      `… +${padded.length - 1199} more characters`,
    );
  });

  it("shows terminal escapes and bidi overrides as text instead of passing them through", () => {
    const sneaky = "echo safe\u001b[8m; rm -rf ~\u001b[0m \u202eevil";
    expect(previewLines(sneaky)).toEqual([
      "echo safe\\x1b[8m; rm -rf ~\\x1b[0m \\u202eevil",
    ]);
    expect(previewLines("a\tb")).toEqual(["a\tb"]);
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
    expect(hiddenLinesNote(0, 1)).toBe("… +1 more character");
    expect(hiddenLinesNote(3, 40)).toBe("… +40 more characters, +3 more lines");
  });
});

describe("pagePreview (ATO-876)", () => {
  const limits = { maxLines: 20, maxChars: 1200 };

  it("puts a short command on one page", () => {
    expect(pagePreview(SCRIPT, limits)).toEqual([
      ["echo hi", "mkdir -p out", "rm -rf out/cache"],
    ]);
  });

  it("shows every line of a long script once, in order, the last one included", () => {
    const lines = Array.from({ length: 45 }, (_, i) => `echo line-${i + 1}`);
    lines[44] = "rm -rf ~";
    const pages = pagePreview(lines.join("\n"), limits);
    expect(pages.map((page) => page.length)).toEqual([20, 20, 5]);
    expect(pages.flat()).toEqual(lines);
    expect(pages.at(-1)?.at(-1)).toBe("rm -rf ~");
  });

  it("splits a line past the character budget instead of cutting it", () => {
    const padded = `echo ${" ".repeat(3000)}; rm -rf ~`;
    const pages = pagePreview(padded, limits);
    expect(pages.length).toBe(3);
    for (const page of pages) {
      expect(page.join("\n").length).toBeLessThanOrEqual(1200);
    }
    expect(pages.flat().join("")).toBe(padded);
  });

  it("keeps each page inside the character budget", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(500));
    const pages = pagePreview(lines.join("\n"), limits);
    for (const page of pages) {
      expect(page.join("\n").length).toBeLessThanOrEqual(1200);
    }
    expect(pages.flat()).toEqual(lines);
  });

  it("escapes controls the same way the excerpt does", () => {
    expect(pagePreview("echo \u001b[8mhidden", limits)).toEqual([
      ["echo \\x1b[8mhidden"],
    ]);
  });
});

describe("isPreviewCut (ATO-876)", () => {
  const limits = { maxLines: 20, maxChars: 1200 };

  it("is false when the excerpt shows everything", () => {
    expect(isPreviewCut(SCRIPT, limits)).toBe(false);
  });

  it("is true when lines are left out", () => {
    const script = Array.from({ length: 25 }, (_, i) => `echo ${i}`).join("\n");
    expect(isPreviewCut(script, limits)).toBe(true);
  });

  it("is true when the one line shown is cut", () => {
    expect(isPreviewCut("x".repeat(1300), limits)).toBe(true);
  });
});
