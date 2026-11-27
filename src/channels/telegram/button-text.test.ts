import { describe, expect, it } from "vitest";

import { BUTTON_TEXT_MAX_CHARS, fitButtonText, shortenMiddle } from "./button-text.js";

// ATO-2757: a long approval button keeps its scope words.

describe("fitButtonText", () => {
  it("leaves a label that fits alone", () => {
    expect(fitButtonText("Allow shell command this session")).toBe(
      "Allow shell command this session",
    );
  });

  it("keeps 'this session' and the end of a long host", () => {
    const host = `${"very-long-subdomain-".repeat(4)}shop.example.com`;
    const text = fitButtonText(`Allow browser commit on ${host} this session`);
    expect(Array.from(text).length).toBeLessThanOrEqual(BUTTON_TEXT_MAX_CHARS);
    expect(text.startsWith("Allow browser")).toBe(true);
    expect(text.endsWith("example.com this session")).toBe(true);
    expect(text).toContain("…");
  });

  it("keeps 'in this project' and the file name of a long path", () => {
    const path = "/Users/someone/Projects/client-work/very/deeply/nested/folder/notes.md";
    const text = fitButtonText(`Always allow fs.read (read outside) under ${path} in this project`);
    expect(Array.from(text).length).toBeLessThanOrEqual(BUTTON_TEXT_MAX_CHARS);
    expect(text.startsWith("Always allow ")).toBe(true);
    expect(text.endsWith("notes.md in this project")).toBe(true);
  });

  it("keeps 'this session' after a long command shape", () => {
    const text = fitButtonText(`Allow all ${"x".repeat(200)} this session`);
    expect(Array.from(text).length).toBe(BUTTON_TEXT_MAX_CHARS);
    expect(text.startsWith("Allow all x")).toBe(true);
    expect(text.endsWith("x this session")).toBe(true);
  });

  it("shortens a label with no known scope in its middle, keeping its end", () => {
    const text = fitButtonText(`${"a".repeat(40)}${"b".repeat(40)}`);
    expect(text).toBe(`${"a".repeat(29)}…${"b".repeat(30)}`);
  });
});

describe("shortenMiddle", () => {
  it("never splits an emoji", () => {
    const text = shortenMiddle("😀".repeat(20), 9);
    expect(Array.from(text)).toHaveLength(9);
    expect(text).toBe(`${"😀".repeat(4)}…${"😀".repeat(4)}`);
  });
});
