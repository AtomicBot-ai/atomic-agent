import { describe, expect, it } from "vitest";
import {
  ATOM_COLLISION_GLYPH,
  ATOM_GLYPH,
  ATOM_WIDTH,
  atomPopulation,
  createAtomField,
  stepAtoms,
  type AtomBounds,
} from "./atom-field.js";

/**
 * Rarity is measured at production parameters — the shipped seed, the
 * population the pane would actually get — across the geometries the
 * row budget really emits, smallest first. The smallest is the one
 * that bites: five atoms in three rows were hot on 22% of steps
 * before the population learned to scale. The ceilings are ~2× the
 * measured rates, so a regression that doubles the rate fails.
 */
describe("collision rarity at production geometry", () => {
  const rarity: { name: string; bounds: AtomBounds; maxHot: number }[] = [
    // 90×20 terminal: the minimum budget that still draws a field.
    // Measured 39/2000 hot steps (2.0%).
    { name: "the minimum field (89×3)", bounds: { columns: 89, rows: 3 }, maxHot: 80 },
    // 80×20 terminal. Measured 50/2000 (2.5%).
    { name: "a narrow minimum (79×3)", bounds: { columns: 79, rows: 3 }, maxHot: 100 },
    // 100×24 terminal. Measured 144/2000 (7.2%).
    { name: "a mid-size pane (99×7)", bounds: { columns: 99, rows: 7 }, maxHot: 250 },
    // 100×30 terminal. Measured 126/2000 (6.3%).
    { name: "a full-size pane (99×13)", bounds: { columns: 99, rows: 13 }, maxHot: 250 },
  ];

  for (const tier of rarity) {
    it(`keeps collisions rare on ${tier.name}`, () => {
      const count = atomPopulation(tier.bounds);
      let state = createAtomField({ bounds: tier.bounds, count, seed: 20260821 });
      let hotSteps = 0;
      for (let i = 0; i < 2000; i += 1) {
        state = stepAtoms(state, tier.bounds);
        if (state.atoms.some((placed) => placed.hotSteps > 0)) hotSteps += 1;
      }
      // Rare, not extinct: the event still has to happen to be one.
      expect(hotSteps).toBeGreaterThan(0);
      expect(hotSteps).toBeLessThan(tier.maxHot);
    });
  }
});

describe("atomPopulation", () => {
  const tiers: { bounds: AtomBounds; count: number }[] = [
    { bounds: { columns: 99, rows: 13 }, count: 5 },
    { bounds: { columns: 119, rows: 23 }, count: 5 },
    { bounds: { columns: 99, rows: 7 }, count: 4 },
    { bounds: { columns: 99, rows: 6 }, count: 3 },
    { bounds: { columns: 199, rows: 3 }, count: 3 },
    { bounds: { columns: 89, rows: 3 }, count: 2 },
    { bounds: { columns: 79, rows: 3 }, count: 2 },
  ];
  for (const tier of tiers) {
    it(`gives ${tier.count} atoms to ${tier.bounds.columns}×${tier.bounds.rows}`, () => {
      expect(atomPopulation(tier.bounds)).toBe(tier.count);
    });
  }

  it("never hands out fewer than a pair — zero atoms is no field at all", () => {
    expect(atomPopulation({ columns: 10, rows: 3 })).toBe(2);
  });
});

describe("collision glyph", () => {
  it("is a different shape from the resting atom, not just a colour", () => {
    // The collision has to survive NO_COLOR and monochrome terminals.
    expect(ATOM_COLLISION_GLYPH).not.toBe(ATOM_GLYPH);
  });

  it("is exactly as wide, so going hot never moves a neighbour", () => {
    expect([...ATOM_COLLISION_GLYPH]).toHaveLength(ATOM_WIDTH);
    expect([...ATOM_GLYPH]).toHaveLength(ATOM_WIDTH);
  });
});
