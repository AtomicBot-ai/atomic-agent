import { describe, expect, it } from "vitest";
import { mixColor } from "./mix-color.js";

describe("mixColor", () => {
  it("returns the ends untouched", () => {
    expect(mixColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColor("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("blends per channel", () => {
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColor("#ff0000", "#0000ff", 0.25)).toBe("#bf0040");
  });

  it("clamps a ratio outside 0..1", () => {
    expect(mixColor("#102030", "#ffffff", -3)).toBe("#102030");
    expect(mixColor("#102030", "#ffffff", 9)).toBe("#ffffff");
  });

  /**
   * A palette could grow a named or ANSI-indexed colour. Rendering is
   * not the place to discover that, so an unreadable input yields the
   * first colour rather than an exception or a black chip.
   */
  it("falls back to the first colour when either side is unreadable", () => {
    expect(mixColor("#102030", "blue", 0.5)).toBe("#102030");
    expect(mixColor("blue", "#102030", 0.5)).toBe("blue");
  });
});
