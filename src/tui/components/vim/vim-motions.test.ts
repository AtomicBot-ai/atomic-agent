import { describe, expect, it } from "vitest";
import { resolveMotion, type VimMotion } from "./vim-motions.js";

// o0 n1 e2 \n3 _4 _5 t6 w7 o8 \n9 t10 h11 r12 e13 e14
const LINES = "one\n  two\nthree";

function to(
  value: string,
  cursor: number,
  motion: VimMotion,
  count = 1,
  hasCount = false,
): number | null {
  return resolveMotion(value, cursor, motion, count, hasCount)?.cursor ?? null;
}

describe("vim motions", () => {
  it("h / l stay on the caret's line", () => {
    expect(to(LINES, 6, "h")).toBe(5);
    expect(to(LINES, 6, "h", 5)).toBe(4);
    expect(to(LINES, 4, "h")).toBe(4);
    expect(to(LINES, 6, "l")).toBe(7);
    expect(to(LINES, 6, "l", 10)).toBe(9);
  });

  it("j / k keep the column, clamp to a shorter line, and stop at the edges", () => {
    expect(to(LINES, 1, "j")).toBe(5);
    expect(to(LINES, 2, "j", 2)).toBe(12);
    expect(to(LINES, 12, "k")).toBe(6);
    expect(to(LINES, 14, "k", 2)).toBe(3);
    expect(to("abcdef\nab", 5, "j")).toBe(9);
    expect(to(LINES, 12, "j")).toBeNull();
    expect(to(LINES, 0, "k")).toBeNull();
    expect(to(LINES, 0, "j", 9)).toBe(10);
  });

  it("j / k are linewise, e is inclusive, w and b are exclusive", () => {
    expect(resolveMotion(LINES, 1, "j", 1, false)?.linewise).toBe(true);
    expect(resolveMotion(LINES, 0, "e", 1, false)?.inclusive).toBe(true);
    expect(resolveMotion(LINES, 0, "w", 1, false)).toEqual({
      cursor: 6,
      linewise: false,
      inclusive: false,
    });
    expect(resolveMotion(LINES, 6, "b", 1, false)?.inclusive).toBe(false);
  });

  it("w / b / e repeat with a count and stop at the buffer's ends", () => {
    expect(to("a b c d", 0, "w", 3)).toBe(6);
    expect(to("a b c d", 0, "w", 99)).toBe(7);
    expect(to("a b c d", 6, "b", 2)).toBe(2);
    expect(to("a b c d", 6, "b", 99)).toBe(0);
    expect(to("ab cd ef", 0, "e", 2)).toBe(4);
  });

  it("0 / ^ / $ go to the line's start, first non-blank and end", () => {
    expect(to(LINES, 8, "0")).toBe(4);
    expect(to(LINES, 8, "^")).toBe(6);
    expect(to(LINES, 4, "$")).toBe(9);
    expect(to(LINES, 1, "$", 2)).toBe(9);
    expect(to(LINES, 1, "$", 99)).toBe(15);
  });

  it("gg / G go to the first / last line, or to line N with a count", () => {
    expect(to(LINES, 12, "gg")).toBe(0);
    expect(to(LINES, 0, "G")).toBe(10);
    expect(to(LINES, 0, "G", 2, true)).toBe(6);
    expect(to(LINES, 12, "gg", 2, true)).toBe(6);
    expect(to(LINES, 0, "G", 99, true)).toBe(10);
    expect(resolveMotion(LINES, 0, "G", 1, false)?.linewise).toBe(true);
  });
});
