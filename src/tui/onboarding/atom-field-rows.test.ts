import { describe, expect, it } from "vitest";
import { buildAtomRows } from "./atom-field-rows.js";
import {
  ATOM_COLLISION_GLYPH,
  ATOM_GLYPH,
  COLLISION_STEPS,
  createAtomField,
  stepAtoms,
  type Atom,
  type AtomBounds,
  type AtomFieldState,
} from "./atom-field.js";

const BOUNDS: AtomBounds = { columns: 30, rows: 5 };

function atom(over: Partial<Atom> = {}): Atom {
  return {
    id: 1,
    column: 4,
    row: 2,
    columnVelocity: 0.6,
    rowVelocity: 0.27,
    hotSteps: 0,
    lifeSteps: 30,
    dormantSteps: 0,
    ...over,
  };
}

function field(atoms: Atom[]): AtomFieldState {
  return { atoms, seed: 1, step: 0, nextId: atoms.length + 1 };
}

const text = (rows: { text: string }[][]): string[] =>
  rows.map((runs) => runs.map((run) => run.text).join(""));

describe("buildAtomRows", () => {
  it("returns exactly as many rows as the budget allows", () => {
    const state = createAtomField({ bounds: BOUNDS, count: 4, seed: 5 });
    expect(buildAtomRows(state, BOUNDS)).toHaveLength(BOUNDS.rows);
  });

  it("draws the atom at its rounded cell and nowhere else", () => {
    const rows = text(buildAtomRows(field([atom({ column: 4.4, row: 2.4 })]), BOUNDS));
    expect(rows[2]).toBe(`${" ".repeat(4)}${ATOM_GLYPH}`);
    expect(rows.filter((row) => row.includes(ATOM_GLYPH))).toHaveLength(1);
  });

  it("leaves the rows an atom is not on blank", () => {
    const rows = text(buildAtomRows(field([atom()]), BOUNDS));
    expect(rows[0]).toBe("");
    expect(rows[4]).toBe("");
  });

  it("skips a dormant atom rather than drawing it where it died", () => {
    const rows = text(buildAtomRows(field([atom({ dormantSteps: 3 })]), BOUNDS));
    expect(rows.join("")).toBe("");
  });

  it("marks a collided atom's cells hot and leaves the rest cold", () => {
    const runs = buildAtomRows(field([atom({ hotSteps: COLLISION_STEPS })]), BOUNDS);
    const hot = runs[2]!.filter((run) => run.hot);
    expect(hot.map((run) => run.text).join("")).toBe(ATOM_COLLISION_GLYPH);
    expect(runs[0]!.some((run) => run.hot)).toBe(false);
  });

  it("swaps the glyph while hot, so a collision reads without colour", () => {
    const cold = text(buildAtomRows(field([atom()]), BOUNDS));
    const hot = text(buildAtomRows(field([atom({ hotSteps: COLLISION_STEPS })]), BOUNDS));
    expect(cold[2]).toContain(ATOM_GLYPH);
    expect(hot[2]).toContain(ATOM_COLLISION_GLYPH);
    expect(hot[2]).not.toContain(ATOM_GLYPH);
    // Same cells, different marker: shape is the signal, never position.
    expect(hot[2]!.replace(ATOM_COLLISION_GLYPH, ATOM_GLYPH)).toBe(cold[2]);
  });

  it("keeps a hot cell's glyph when a cold atom drifts over it", () => {
    // Later atoms paint over earlier ones cell by cell; hot must win
    // for the shape as well as the colour, or the overlap would show a
    // green resting glyph — a signal wearing the wrong uniform.
    const overlapped = buildAtomRows(
      field([
        atom({ id: 1, column: 10, hotSteps: COLLISION_STEPS }),
        atom({ id: 2, column: 11, hotSteps: 0 }),
      ]),
      BOUNDS,
    );
    const row = overlapped[2]!;
    for (const run of row) {
      if (!run.hot) continue;
      for (const glyph of [...run.text]) {
        expect([...ATOM_COLLISION_GLYPH]).toContain(glyph);
      }
    }
  });

  it("clips an atom against the right edge rather than widening the row", () => {
    const rows = text(
      buildAtomRows(field([atom({ column: BOUNDS.columns - 1, row: 1 })]), BOUNDS),
    );
    expect(rows[1]!.length).toBeLessThanOrEqual(BOUNDS.columns);
    expect(rows[1]).toContain("(");
  });

  it("never emits a row wider or a field taller than the pane", () => {
    let state = createAtomField({ bounds: BOUNDS, count: 5, seed: 13 });
    for (let i = 0; i < 120; i += 1) {
      const rows = buildAtomRows(state, BOUNDS);
      expect(rows).toHaveLength(BOUNDS.rows);
      for (const row of text(rows)) {
        expect(row.length).toBeLessThanOrEqual(BOUNDS.columns);
      }
      state = stepAtoms(state, BOUNDS);
    }
  });

  it("has nothing to draw when the budget is zero rows", () => {
    const rows = buildAtomRows(field([atom()]), { columns: 30, rows: 0 });
    expect(rows).toEqual([]);
  });
});
