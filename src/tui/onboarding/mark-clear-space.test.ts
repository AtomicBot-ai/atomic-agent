import { describe, expect, it } from "vitest";
import { CROSS_MARKS } from "../components/logo-art.js";
import { computeMarkClearSpans } from "./mark-clear-space.js";

const MARK = CROSS_MARKS.block.md;

/** A cross narrow at the ends and wide in the middle, like the real one. */
const TOY = ["  ██  ", "██████", "  ██  "];

describe("computeMarkClearSpans", () => {
  it("widens each row's ink by the gap on both axes", () => {
    const spans = computeMarkClearSpans({
      markRows: TOY,
      top: 1,
      left: 10,
      rows: 5,
      gapRows: 0,
      gapColumns: 1,
    });
    expect(spans).toEqual([
      { row: 1, from: 11, to: 14 },
      { row: 2, from: 9, to: 16 },
      { row: 3, from: 11, to: 14 },
    ]);
  });

  it("carries a wide row's span into the rows within the vertical gap", () => {
    const spans = computeMarkClearSpans({
      markRows: TOY,
      top: 1,
      left: 10,
      rows: 6,
      gapRows: 1,
      gapColumns: 0,
    });
    // The crossbar's width reaches one row up and one row down, so the
    // three middle rows are all as wide as it is; the rows a step beyond
    // the mark inherit only the narrow tip nearest them.
    expect(spans).toEqual([
      { row: 0, from: 12, to: 13 },
      { row: 1, from: 10, to: 15 },
      { row: 2, from: 10, to: 15 },
      { row: 3, from: 10, to: 15 },
      { row: 4, from: 12, to: 13 },
    ]);
  });

  it("leaves the rows out of the mark's reach unclaimed", () => {
    const spans = computeMarkClearSpans({
      markRows: TOY,
      top: 4,
      left: 10,
      rows: 12,
      gapRows: 2,
      gapColumns: 4,
    });
    const claimed = new Set(spans.map((span) => span.row));
    for (const row of [0, 1, 9, 10, 11]) expect(claimed.has(row)).toBe(false);
    for (const row of [2, 3, 4, 5, 6, 7, 8]) expect(claimed.has(row)).toBe(true);
  });

  it("stops at the canvas rather than running off it", () => {
    const spans = computeMarkClearSpans({
      markRows: TOY,
      top: -1,
      left: 0,
      rows: 3,
      gapRows: 1,
      gapColumns: 2,
    });
    for (const span of spans) {
      expect(span.row).toBeGreaterThanOrEqual(0);
      expect(span.row).toBeLessThan(3);
    }
  });

  it("claims nothing for a mark with no ink in it", () => {
    expect(
      computeMarkClearSpans({
        markRows: [],
        top: 0,
        left: 0,
        rows: 8,
        gapRows: 2,
        gapColumns: 4,
      }),
    ).toEqual([]);
    expect(
      computeMarkClearSpans({
        markRows: ["   ", "   "],
        top: 0,
        left: 0,
        rows: 8,
        gapRows: 2,
        gapColumns: 4,
      }),
    ).toEqual([]);
  });

  it("covers every inked cell of the shipped mark, with the gap around it", () => {
    const top = 3;
    const left = 32;
    const spans = computeMarkClearSpans({
      markRows: MARK,
      top,
      left,
      rows: 20,
      gapRows: 2,
      gapColumns: 4,
    });
    const byRow = new Map(spans.map((span) => [span.row, span]));
    for (const [index, row] of MARK.entries()) {
      for (const [column, glyph] of [...row].entries()) {
        if (glyph === " ") continue;
        const span = byRow.get(top + index);
        expect(span).toBeDefined();
        expect(span!.from).toBeLessThanOrEqual(left + column - 4);
        expect(span!.to).toBeGreaterThanOrEqual(left + column + 4);
      }
    }
  });

  it("leaves the quadrants between the arms open, unlike a bounding box", () => {
    const spans = computeMarkClearSpans({
      markRows: MARK,
      top: 3,
      left: 32,
      rows: 20,
      gapRows: 2,
      gapColumns: 4,
    });
    const widest = Math.max(...spans.map((span) => span.to - span.from));
    const narrowest = Math.min(...spans.map((span) => span.to - span.from));
    // A box would claim the same width on every row. The cross narrows at
    // its top and bottom, and the sky is allowed in there.
    expect(narrowest).toBeLessThan(widest - 10);
  });
});
