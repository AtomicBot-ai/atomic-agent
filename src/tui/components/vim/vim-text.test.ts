import { describe, expect, it } from "vitest";
import {
  charClass,
  clampNormal,
  firstNonBlank,
  lineCount,
  lineIndexOf,
  nextWordStart,
  offsetOfLine,
  prevWordStart,
  wordEnd,
} from "./vim-text.js";

// "foo bar_baz, qux": f0 o1 o2 _3 b4 … z10 ,11 _12 q13 u14 x15
const WORDS = "foo bar_baz, qux";

describe("vim text geometry", () => {
  it("classes blanks, keyword characters and punctuation apart", () => {
    expect(charClass(" ")).toBe(0);
    expect(charClass("\n")).toBe(0);
    expect(charClass(undefined)).toBe(0);
    expect(charClass("a")).toBe(1);
    expect(charClass("_")).toBe(1);
    expect(charClass("7")).toBe(1);
    expect(charClass("é")).toBe(1);
    expect(charClass(",")).toBe(2);
    expect(charClass("/")).toBe(2);
  });

  it("keeps the NORMAL caret on a character, never past a line's end", () => {
    expect(clampNormal("abc", 3)).toBe(2);
    expect(clampNormal("abc", 99)).toBe(2);
    expect(clampNormal("abc", 1)).toBe(1);
    expect(clampNormal("ab\ncd", 2)).toBe(1);
    expect(clampNormal("ab\n\ncd", 3)).toBe(3);
    expect(clampNormal("", 0)).toBe(0);
    expect(clampNormal("abc", -4)).toBe(0);
  });

  it("finds the first non-blank of the caret's line", () => {
    expect(firstNonBlank("  \tfoo", 5)).toBe(3);
    expect(firstNonBlank("x\n   ", 3)).toBe(5);
    expect(firstNonBlank("", 0)).toBe(0);
  });

  it("counts and indexes lines", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(3);
    expect(lineIndexOf("a\nb\nc", 0)).toBe(0);
    expect(lineIndexOf("a\nb\nc", 2)).toBe(1);
    expect(lineIndexOf("a\nb\nc", 4)).toBe(2);
    expect(offsetOfLine("a\nbb\nc", 2)).toBe(5);
    expect(offsetOfLine("a\nbb\nc", 9)).toBe(5);
  });

  it("w lands on the next word, keyword and punctuation runs apart", () => {
    expect(nextWordStart(WORDS, 0)).toBe(4);
    expect(nextWordStart(WORDS, 4)).toBe(11);
    expect(nextWordStart(WORDS, 11)).toBe(13);
    expect(nextWordStart(WORDS, 13)).toBe(16);
    expect(nextWordStart(WORDS, 16)).toBe(16);
    expect(nextWordStart("one\n  two", 0)).toBe(6);
    expect(nextWordStart("a   b", 1)).toBe(4);
  });

  it("b lands on the start of this word or the previous one", () => {
    expect(prevWordStart(WORDS, 13)).toBe(11);
    expect(prevWordStart(WORDS, 11)).toBe(4);
    expect(prevWordStart(WORDS, 6)).toBe(4);
    expect(prevWordStart(WORDS, 4)).toBe(0);
    expect(prevWordStart(WORDS, 0)).toBe(0);
    expect(prevWordStart("one\n  two", 6)).toBe(0);
  });

  it("e lands on the end of this word or the next one", () => {
    expect(wordEnd(WORDS, 0)).toBe(2);
    expect(wordEnd(WORDS, 2)).toBe(10);
    expect(wordEnd(WORDS, 10)).toBe(11);
    expect(wordEnd(WORDS, 15)).toBe(15);
    expect(wordEnd("ab  ", 1)).toBe(3);
    expect(wordEnd("", 0)).toBe(0);
  });
});
