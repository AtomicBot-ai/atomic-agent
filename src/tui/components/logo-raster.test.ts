import { describe, expect, it } from "vitest";

import { LOGO_ART } from "./logo.js";
import { rasteriseMark, toInkMask } from "./logo-raster.js";
import { LOGO_METRICS } from "./splash-fit.js";

const source = toInkMask(LOGO_ART.full);

/** Ink coverage as a fraction of the box — a crude "does it look like the mark". */
function density(rows: readonly string[]): number {
  const total = rows.reduce((acc, row) => acc + row.length, 0);
  if (total === 0) return 0;
  const ink = rows.reduce(
    (acc, row) => acc + [...row].filter((ch) => ch !== " ").length,
    0,
  );
  return ink / total;
}

describe("rasteriseMark", () => {
  it("returns exactly the box it was asked for", () => {
    for (const [columns, rows] of [
      [20, 12],
      [13, 8],
      [7, 4],
    ] as const) {
      const art = rasteriseMark(source, { columns, rows });
      expect(art).toHaveLength(rows);
      for (const line of art) expect(line).toHaveLength(columns);
    }
  });

  it("keeps the mark's aspect ratio instead of stretching it", () => {
    // The source is 34 cells wide and 20 tall = 34x40 half-block pixels.
    // Asked for a box twice as wide as that shape needs, the drawing must
    // stay its own shape and sit centred, not stretch to the edges.
    const art = rasteriseMark(source, { columns: 60, rows: 12 });
    const drawn = art.filter((row) => row.trim().length > 0);
    const leading = Math.min(
      ...drawn.map((row) => row.length - row.trimStart().length),
    );
    const trailing = Math.min(
      ...drawn.map((row) => row.length - row.trimEnd().length),
    );
    // 12 cell rows = 24 pixels tall, so a 34x40 source scales to 0.6 and
    // draws ~20 columns wide — nowhere near the 60 it was offered.
    const inkWidth = 60 - leading - trailing;
    expect(inkWidth).toBeLessThanOrEqual(22);
    expect(leading).toBeGreaterThan(0);
  });

  it("still draws something recognisable at the smallest size", () => {
    // Regression on the reason this module exists: the hand-drawn
    // half-size mark had lost its arms and read as a solid blob.
    // A blob is ~100% ink; empty is 0. The real mark sits in between.
    const mini = rasteriseMark(source, {
      columns: LOGO_METRICS.mini.width,
      rows: LOGO_METRICS.mini.height,
    });
    expect(mini).toHaveLength(LOGO_METRICS.mini.height);
    expect(density(mini)).toBeGreaterThan(0.25);
    expect(density(mini)).toBeLessThan(0.85);
  });

  it("never scales the drawing up past its natural size", () => {
    const art = rasteriseMark(source, { columns: 200, rows: 60 });
    const widest = art.reduce(
      (acc, row) => Math.max(acc, row.trimEnd().length),
      0,
    );
    expect(widest).toBeLessThanOrEqual(200);
    const drawn = art.filter((row) => row.trim().length > 0);
    expect(drawn.length).toBeLessThanOrEqual(20);
  });

  it("degrades to nothing rather than throwing on a zero-sized box", () => {
    expect(rasteriseMark(source, { columns: 0, rows: 0 })).toEqual([]);
    expect(rasteriseMark([], { columns: 10, rows: 4 })).toEqual([]);
  });
});
