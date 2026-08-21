import { describe, expect, it } from "vitest";
import { buildIntroArt, ORBIT_GLYPH } from "./intro-art.js";
import { CROSS_MARKS } from "../components/logo-art.js";

const MARK = CROSS_MARKS.block.md;

describe("buildIntroArt", () => {
  it("centres the mark", () => {
    const art = buildIntroArt({ columns: 100, rows: 24, markRows: MARK, crossCount: 0 });
    const bar = art.find((row) => row.trim().startsWith("█".repeat(20)));
    expect(bar).toBeDefined();
    const left = (bar ?? "").length - (bar ?? "").trimStart().length;
    const right = 100 - (bar ?? "").length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  });

  it("never grows past the rows it was given", () => {
    for (const rows of [12, 18, 24, 30]) {
      const art = buildIntroArt({ columns: 100, rows, markRows: MARK, crossCount: 14 });
      expect(art.length).toBeLessThanOrEqual(Math.max(rows, MARK.length));
    }
  });

  it("rings the mark when there is room for the clear space", () => {
    const art = buildIntroArt({ columns: 100, rows: 26, markRows: MARK, crossCount: 14 });
    expect(art.join("\n")).toContain(ORBIT_GLYPH);
  });

  it("drops the ring rather than resting a cross against an arm", () => {
    // 40 columns cannot hold the mark's clear space, let alone a ring.
    const art = buildIntroArt({ columns: 40, rows: 26, markRows: MARK, crossCount: 14 });
    expect(art.join("\n")).not.toContain(ORBIT_GLYPH);
  });

  it("draws the mark alone when asked for no crosses", () => {
    const art = buildIntroArt({ columns: 100, rows: 24, markRows: MARK, crossCount: 0 });
    expect(art.join("\n")).not.toContain(ORBIT_GLYPH);
    expect(art.join("\n")).toContain("█");
  });

  it("never overwrites the mark with a cross", () => {
    const art = buildIntroArt({ columns: 100, rows: 30, markRows: MARK, crossCount: 40 });
    const markGlyphs = art.join("").split("").filter((g) => g === "█").length;
    const plain = buildIntroArt({ columns: 100, rows: 30, markRows: MARK, crossCount: 0 });
    const plainGlyphs = plain.join("").split("").filter((g) => g === "█").length;
    expect(markGlyphs).toBe(plainGlyphs);
  });
});
