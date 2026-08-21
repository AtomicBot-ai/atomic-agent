import { describe, expect, it } from "vitest";
import { renderProgressBar } from "./render-progress-bar.js";

describe("renderProgressBar", () => {
  it("is always exactly `width` cells wide", () => {
    for (const percent of [0, 1, 37, 99, 100]) {
      expect(renderProgressBar(percent, 8)).toHaveLength(8);
    }
  });

  it("fills proportionally, rounding to the nearest cell", () => {
    expect(renderProgressBar(0, 8)).toBe("        ");
    expect(renderProgressBar(50, 8)).toBe("====    ");
    expect(renderProgressBar(100, 8)).toBe("========");
    // 37% of 8 is 2.96 cells.
    expect(renderProgressBar(37, 8)).toBe("===     ");
  });

  it("clamps a percentage past the end instead of overflowing the row", () => {
    expect(renderProgressBar(140, 8)).toBe("========");
  });
});
