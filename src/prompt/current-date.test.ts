import { describe, it, expect } from "vitest";
import { formatCurrentDate } from "./current-date.js";

describe("formatCurrentDate", () => {
  it("formats as YYYY-MM-DD with the weekday in parentheses", () => {
    // 2026-06-09 is a Tuesday.
    const result = formatCurrentDate(new Date(2026, 5, 9, 11, 56));
    expect(result).toBe("2026-06-09 (Tuesday)");
  });

  it("zero-pads single-digit months and days", () => {
    const result = formatCurrentDate(new Date(2026, 0, 3, 0, 0));
    expect(result).toMatch(/^2026-01-03 \(\w+\)$/);
  });

  it("is byte-stable across times within the same calendar day", () => {
    const morning = formatCurrentDate(new Date(2026, 5, 9, 1, 0));
    const evening = formatCurrentDate(new Date(2026, 5, 9, 23, 59));
    expect(morning).toBe(evening);
  });
});
