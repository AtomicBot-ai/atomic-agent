import { describe, expect, it } from "vitest";
import { CROSS_MARKS } from "../components/logo-art.js";
import { buildIntroArt } from "./intro-art.js";
import { STAR_GLYPHS, starTierOfGlyph, type StarTier } from "./star-tiers.js";

const MARK = CROSS_MARKS.block.md;
const MARK_GLYPHS = new Set(["█", "▓", "░"]);
/** The gaps `intro-art` keeps between the mark's ink and the nearest star. */
const GAP_ROWS = 2;
const GAP_COLUMNS = 4;
/** A 100×30 terminal, minus the frame and the intro's own chrome. */
const OPENS_AT = { columns: 96, rows: 20 } as const;

interface Placed {
  row: number;
  column: number;
  tier: StarTier;
}

function stars(art: readonly string[]): Placed[] {
  const placed: Placed[] = [];
  for (const [row, line] of art.entries()) {
    for (const [column, glyph] of [...line].entries()) {
      const tier = starTierOfGlyph(glyph);
      if (tier) placed.push({ row, column, tier });
    }
  }
  return placed;
}

/** First and last inked column of the mark on each art row. */
function markSpans(art: readonly string[]): ({ from: number; to: number } | null)[] {
  return art.map((line) => {
    const inked = [...line].flatMap((glyph, index) =>
      MARK_GLYPHS.has(glyph) ? [index] : [],
    );
    if (inked.length === 0) return null;
    return { from: Math.min(...inked), to: Math.max(...inked) };
  });
}

describe("buildIntroArt", () => {
  it("centres the mark", () => {
    const art = buildIntroArt({ columns: 100, rows: 24, markRows: MARK });
    const bar = art.find((row) => row.trim().startsWith("█".repeat(20)));
    expect(bar).toBeDefined();
    const left = (bar ?? "").length - (bar ?? "").trimStart().length;
    const right = 100 - (bar ?? "").length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  });

  it("never grows past the rows it was given", () => {
    for (const rows of [12, 18, 20, 24, 30]) {
      const art = buildIntroArt({
        columns: 100,
        rows,
        markRows: MARK,
        density: 1,
        haloCount: 26,
      });
      expect(art.length).toBeLessThanOrEqual(Math.max(rows, MARK.length));
    }
  });

  it("uses every row of its budget once there is a sky to put in it", () => {
    for (const rows of [20, 24, 30]) {
      const art = buildIntroArt({ columns: 100, rows, markRows: MARK, density: 1 });
      expect(art.length).toBe(rows);
    }
  });

  it("draws the mark alone when the sky is switched off", () => {
    const art = buildIntroArt({ columns: 100, rows: 24, markRows: MARK, density: 0 });
    expect(stars(art)).toEqual([]);
    expect(art.join("\n")).toContain("█");
    expect(art.length).toBe(MARK.length);
  });

  it("fills the sky at the size the flow actually opens at", () => {
    const art = buildIntroArt({ ...OPENS_AT, markRows: MARK, density: 1, haloCount: 26 });
    const placed = stars(art);
    expect(placed.length).toBeGreaterThan(100);
    // Both sides of the mark, not one strip down the edge.
    expect(placed.filter((star) => star.column < 30).length).toBeGreaterThan(20);
    expect(placed.filter((star) => star.column > 66).length).toBeGreaterThan(20);
    // Above and below it too — a bounding-box clear space would leave the
    // top and bottom of the canvas as the only room for those.
    expect(placed.filter((star) => star.row < 3).length).toBeGreaterThan(5);
    expect(placed.filter((star) => star.row > 16).length).toBeGreaterThan(5);
  });

  it("puts stars of every brightness in the sky", () => {
    const art = buildIntroArt({ ...OPENS_AT, markRows: MARK, density: 1, haloCount: 26 });
    const tiers = new Set(stars(art).map((star) => star.tier));
    expect(tiers).toEqual(new Set(Object.keys(STAR_GLYPHS)));
  });

  it("keeps the mark's clear space empty on every row", () => {
    const art = buildIntroArt({ ...OPENS_AT, markRows: MARK, density: 1, haloCount: 26 });
    const spans = markSpans(art);
    for (const star of stars(art)) {
      for (let offset = -GAP_ROWS; offset <= GAP_ROWS; offset += 1) {
        const span = spans[star.row + offset];
        if (!span) continue;
        const inside =
          star.column >= span.from - GAP_COLUMNS && star.column <= span.to + GAP_COLUMNS;
        expect({ star, span, offset, inside }).toMatchObject({ inside: false });
      }
    }
  });

  it("never lets a star overwrite the mark", () => {
    const inked = (art: readonly string[]): number =>
      [...art.join("")].filter((glyph) => MARK_GLYPHS.has(glyph)).length;
    const sky = buildIntroArt({ ...OPENS_AT, markRows: MARK, density: 1, haloCount: 26 });
    const plain = buildIntroArt({ ...OPENS_AT, markRows: MARK, density: 0 });
    expect(inked(sky)).toBe(inked(plain));
  });

  it("paints the same sky for the same canvas", () => {
    const options = { ...OPENS_AT, markRows: MARK, density: 1, haloCount: 26 };
    expect(buildIntroArt(options)).toEqual(buildIntroArt(options));
    expect(buildIntroArt({ ...options, seed: 5 })).not.toEqual(
      buildIntroArt({ ...options, seed: 6 }),
    );
  });

  it("thickens the sky as the terminal grows", () => {
    const small = buildIntroArt({ columns: 68, rows: 12, markRows: MARK, density: 1 });
    const large = buildIntroArt({ columns: 116, rows: 30, markRows: MARK, density: 1 });
    expect(stars(large).length).toBeGreaterThan(stars(small).length * 2);
  });
});
