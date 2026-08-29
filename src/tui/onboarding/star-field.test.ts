import { describe, expect, it } from "vitest";
import { CELL_ASPECT } from "./orbit-field.js";
import { computeStarField, type ClearSpan, type Star } from "./star-field.js";
import type { StarTier } from "./star-tiers.js";

/** The canvas a 100×30 terminal leaves for the art block. */
const CANVAS = { columns: 96, rows: 20 } as const;

function countByTier(stars: readonly Star[]): Record<StarTier, number> {
  const counts: Record<StarTier, number> = { bright: 0, mid: 0, dim: 0, faint: 0 };
  for (const star of stars) counts[star.tier] += 1;
  return counts;
}

/**
 * Variance-to-mean ratio of the per-tile star counts. A field sprinkled
 * uniformly is Poisson and sits near 1; clumping pushes it up, which is
 * the only way to say "clustered" as a number rather than by eye.
 */
function dispersion(stars: readonly Star[], columns: number, rows: number): number {
  const across = 8;
  const down = 4;
  const tiles = new Array<number>(across * down).fill(0);
  for (const star of stars) {
    const tx = Math.min(across - 1, Math.floor((star.column / columns) * across));
    const ty = Math.min(down - 1, Math.floor((star.row / rows) * down));
    tiles[ty * across + tx] += 1;
  }
  const mean = tiles.reduce((sum, n) => sum + n, 0) / tiles.length;
  const variance =
    tiles.reduce((sum, n) => sum + (n - mean) ** 2, 0) / tiles.length;
  return variance / mean;
}

/** A deliberately unclustered field of the same size, as the control. */
function uniformField(count: number, columns: number, rows: number): Star[] {
  let state = 12345;
  const roll = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const stars: Star[] = [];
  const taken = new Set<number>();
  while (stars.length < count) {
    const column = Math.floor(roll() * columns);
    const row = Math.floor(roll() * rows);
    const key = row * columns + column;
    if (taken.has(key)) continue;
    taken.add(key);
    stars.push({ column, row, tier: "faint" });
  }
  return stars;
}

describe("computeStarField", () => {
  it("paints the same sky twice for one seed", () => {
    for (const seed of [1, 82, 9001]) {
      expect(computeStarField({ ...CANVAS, seed })).toEqual(
        computeStarField({ ...CANVAS, seed }),
      );
    }
  });

  it("paints a different sky for a different seed", () => {
    expect(computeStarField({ ...CANVAS, seed: 1 })).not.toEqual(
      computeStarField({ ...CANVAS, seed: 2 }),
    );
  });

  it("stays inside the canvas at every size", () => {
    const sizes = [
      { columns: 20, rows: 4 },
      { columns: 68, rows: 8 },
      { columns: 96, rows: 20 },
      { columns: 160, rows: 44 },
    ];
    for (const size of sizes) {
      for (const star of computeStarField(size)) {
        expect(star.column).toBeGreaterThanOrEqual(0);
        expect(star.column).toBeLessThan(size.columns);
        expect(star.row).toBeGreaterThanOrEqual(0);
        expect(star.row).toBeLessThan(size.rows);
      }
    }
  });

  it("never stacks two stars on one cell", () => {
    const stars = computeStarField(CANVAS);
    const cells = new Set(stars.map((star) => `${star.row},${star.column}`));
    expect(cells.size).toBe(stars.length);
  });

  it("keeps out of every span the mark claims", () => {
    // Seed 1, not the default: verified by sweeping seeds against a
    // mutant that honours only the first span per row — under seed 1
    // that mutant puts a star inside the second row-9 span below, so
    // this test actually fails on it. Under the default seed the sky
    // happened to leave those eight cells empty and the multi-span
    // assertion was vacuously green.
    const seed = 1;
    const secondRowNineSpan: ClearSpan = { row: 9, from: 2, to: 9 };
    const spans: ClearSpan[] = [
      { row: 8, from: 28, to: 66 },
      { row: 9, from: 28, to: 66 },
      { row: 10, from: 28, to: 66 },
      { row: 0, from: -5, to: 4 },
      { row: 19, from: 90, to: 200 },
      // A second span on a row already claimed above, so the assertion
      // below is exercised against more than one span per row.
      secondRowNineSpan,
    ];
    // The fixture proves it still bites: with only the second row-9
    // span withheld, the same seed puts a star inside its range. If a
    // regenerated field ever stops doing so, this fails loudly instead
    // of letting the main loop go vacuous again.
    const withheld = spans.filter((span) => span !== secondRowNineSpan);
    expect(
      computeStarField({ ...CANVAS, seed, clearSpans: withheld }).some(
        (star) =>
          star.row === secondRowNineSpan.row &&
          star.column >= secondRowNineSpan.from &&
          star.column <= secondRowNineSpan.to,
      ),
    ).toBe(true);
    for (const star of computeStarField({ ...CANVAS, seed, clearSpans: spans })) {
      // Every span on the row, not just the first: the option is an
      // arbitrary list, and a second span on one row must also hold.
      for (const span of spans.filter((candidate) => candidate.row === star.row)) {
        expect(star.column < span.from || star.column > span.to).toBe(true);
      }
    }
  });

  it("clumps far harder than the same count sprinkled evenly", () => {
    for (const seed of [1, 82, 9001]) {
      const stars = computeStarField({ ...CANVAS, seed });
      const control = uniformField(stars.length, CANVAS.columns, CANVAS.rows);
      const even = dispersion(control, CANVAS.columns, CANVAS.rows);
      const clustered = dispersion(stars, CANVAS.columns, CANVAS.rows);
      expect(even).toBeLessThan(2);
      expect(clustered).toBeGreaterThan(2 * even);
      expect(clustered).toBeGreaterThan(3);
    }
  });

  it("scales the count with the canvas area", () => {
    const sizes = [
      { columns: 48, rows: 8 },
      { columns: 68, rows: 12 },
      { columns: 96, rows: 20 },
      { columns: 116, rows: 30 },
      { columns: 160, rows: 44 },
    ];
    const counts = sizes.map((size) => computeStarField(size).length);
    for (const [index, count] of counts.entries()) {
      if (index === 0) continue;
      expect(count).toBeGreaterThan(counts[index - 1]!);
      // Per cell rather than in total: a big terminal has to be as thick
      // with stars as a small one, not merely hold more of them.
      const size = sizes[index]!;
      const perCell = count / (size.columns * size.rows);
      expect(perCell).toBeGreaterThan(0.05);
      expect(perCell).toBeLessThan(0.09);
    }
  });

  it("spends most of its brightness budget on the dim tiers", () => {
    const counts = countByTier(computeStarField(CANVAS));
    for (const tier of ["bright", "mid", "dim", "faint"] as const) {
      expect(counts[tier]).toBeGreaterThan(0);
    }
    expect(counts.bright).toBeLessThan(counts.mid);
    expect(counts.mid).toBeLessThan(counts.dim);
    expect(counts.dim).toBeLessThan(counts.faint);
  });

  it("draws nothing at all at zero density", () => {
    expect(computeStarField({ ...CANVAS, density: 0 })).toEqual([]);
    expect(computeStarField({ columns: 0, rows: 20 })).toEqual([]);
  });

  it("thins the sky when the density is turned down", () => {
    const full = computeStarField({ ...CANVAS, density: 1 }).length;
    const half = computeStarField({ ...CANVAS, density: 0.5 }).length;
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
  });

  it("hangs the arc off the ellipse it was handed, near it but never on it", () => {
    const center = { row: 10, column: 47 };
    const radius = 20;
    const stars = computeStarField({
      ...CANVAS,
      density: 0,
      seed: 3,
      halo: { center, radius, count: 26 },
    });
    expect(stars.length).toBeGreaterThanOrEqual(12);
    expect(stars.length).toBeLessThan(26);
    for (const star of stars) {
      const reach = Math.hypot(
        star.column - center.column,
        (star.row - center.row) * CELL_ASPECT,
      );
      expect(Math.abs(reach - radius)).toBeLessThan(7);
    }
  });
});
