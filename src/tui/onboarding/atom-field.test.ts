import { describe, expect, it } from "vitest";
import {
  ATOM_WIDTH,
  COLLISION_STEPS,
  createAtomField,
  stepAtoms,
  type Atom,
  type AtomBounds,
  type AtomFieldState,
} from "./atom-field.js";

const BOUNDS: AtomBounds = { columns: 60, rows: 10 };

function atom(over: Partial<Atom> = {}): Atom {
  return {
    id: 1,
    column: 10,
    row: 4,
    columnVelocity: 0.6,
    rowVelocity: 0.27,
    hotSteps: 0,
    lifeSteps: 30,
    dormantSteps: 0,
    ...over,
  };
}

function field(atoms: Atom[], seed = 7): AtomFieldState {
  return { atoms, seed, step: 0, nextId: atoms.length + 1 };
}

function run(state: AtomFieldState, steps: number, bounds = BOUNDS): AtomFieldState {
  let next = state;
  for (let i = 0; i < steps; i += 1) next = stepAtoms(next, bounds);
  return next;
}

describe("createAtomField", () => {
  it("places every atom inside the bounds it was given", () => {
    const state = createAtomField({ bounds: BOUNDS, count: 6, seed: 42 });
    expect(state.atoms).toHaveLength(6);
    for (const placed of state.atoms) {
      expect(placed.column).toBeGreaterThanOrEqual(0);
      expect(placed.column).toBeLessThanOrEqual(BOUNDS.columns - ATOM_WIDTH);
      expect(placed.row).toBeGreaterThanOrEqual(0);
      expect(placed.row).toBeLessThanOrEqual(BOUNDS.rows - 1);
      expect(placed.dormantSteps).toBe(0);
      expect(placed.hotSteps).toBe(0);
    }
  });

  it("survives a pane too small to hold an atom", () => {
    const state = createAtomField({
      bounds: { columns: 1, rows: 1 },
      count: 3,
      seed: 5,
    });
    for (const placed of state.atoms) {
      expect(placed.column).toBe(0);
      expect(placed.row).toBe(0);
    }
  });
});

describe("stepAtoms determinism", () => {
  it("gives the same field from the same seed", () => {
    const a = run(createAtomField({ bounds: BOUNDS, count: 5, seed: 99 }), 200);
    const b = run(createAtomField({ bounds: BOUNDS, count: 5, seed: 99 }), 200);
    expect(a).toStrictEqual(b);
  });

  it("gives a different field from a different seed", () => {
    const a = run(createAtomField({ bounds: BOUNDS, count: 5, seed: 99 }), 40);
    const b = run(createAtomField({ bounds: BOUNDS, count: 5, seed: 100 }), 40);
    expect(a.atoms).not.toStrictEqual(b.atoms);
  });

  it("never mutates the state it was handed", () => {
    const before = createAtomField({ bounds: BOUNDS, count: 4, seed: 3 });
    const snapshot = structuredClone(before);
    run(before, 25);
    expect(before).toStrictEqual(snapshot);
  });
});

describe("stepAtoms bouncing", () => {
  const edges: {
    name: string;
    start: Atom;
    reads(next: Atom): number;
    velocity(next: Atom): number;
  }[] = [
    {
      name: "left",
      start: atom({ column: 0.2, columnVelocity: -0.6, rowVelocity: 0 }),
      reads: (next) => next.column,
      velocity: (next) => next.columnVelocity,
    },
    {
      name: "right",
      start: atom({
        column: BOUNDS.columns - ATOM_WIDTH - 0.2,
        columnVelocity: 0.6,
        rowVelocity: 0,
      }),
      reads: (next) => next.column,
      velocity: (next) => next.columnVelocity,
    },
    {
      name: "top",
      start: atom({ row: 0.1, rowVelocity: -0.27, columnVelocity: 0 }),
      reads: (next) => next.row,
      velocity: (next) => next.rowVelocity,
    },
    {
      name: "bottom",
      start: atom({
        row: BOUNDS.rows - 1 - 0.1,
        rowVelocity: 0.27,
        columnVelocity: 0,
      }),
      reads: (next) => next.row,
      velocity: (next) => next.rowVelocity,
    },
  ];

  for (const edge of edges) {
    it(`turns around at the ${edge.name} edge instead of leaving`, () => {
      const before = edge.start;
      const after = stepAtoms(field([before]), BOUNDS).atoms[0]!;
      expect(edge.velocity(after)).toBe(-edge.velocity(before));
      expect(edge.reads(after)).toBeGreaterThanOrEqual(0);
    });
  }

  it("keeps every atom inside the pane across a long run", () => {
    const state = run(createAtomField({ bounds: BOUNDS, count: 6, seed: 11 }), 500);
    for (const placed of state.atoms) {
      expect(placed.column).toBeGreaterThanOrEqual(0);
      expect(placed.column).toBeLessThanOrEqual(BOUNDS.columns - ATOM_WIDTH);
      expect(placed.row).toBeGreaterThanOrEqual(0);
      expect(placed.row).toBeLessThanOrEqual(BOUNDS.rows - 1);
    }
  });

  it("pulls atoms back in when the terminal shrinks under them", () => {
    const wide = createAtomField({ bounds: { columns: 200, rows: 40 }, count: 5, seed: 8 });
    const narrow = stepAtoms(wide, BOUNDS);
    for (const placed of narrow.atoms) {
      expect(placed.column).toBeLessThanOrEqual(BOUNDS.columns - ATOM_WIDTH);
      expect(placed.row).toBeLessThanOrEqual(BOUNDS.rows - 1);
    }
  });
});

describe("stepAtoms lifecycle", () => {
  it("retires an atom whose life runs out and holds it off screen", () => {
    const dying = stepAtoms(field([atom({ lifeSteps: 1 })]), BOUNDS).atoms[0]!;
    expect(dying.dormantSteps).toBeGreaterThan(0);
    expect(dying.lifeSteps).toBe(0);
  });

  it("brings it back somewhere else rather than where it died", () => {
    const before = atom({ lifeSteps: 1, column: 10, row: 4 });
    // One step retires it; the rest sit out the dormancy and respawn.
    let state = stepAtoms(field([before]), BOUNDS);
    while (state.atoms[0]!.dormantSteps > 0) state = stepAtoms(state, BOUNDS);
    const after = state.atoms[0]!;
    expect(after.dormantSteps).toBe(0);
    expect(after.lifeSteps).toBeGreaterThan(0);
    expect(after.id).not.toBe(before.id);
    expect(after.column === before.column && after.row === before.row).toBe(false);
  });

  it("holds the population steady across a run full of retirements", () => {
    const state = run(createAtomField({ bounds: BOUNDS, count: 5, seed: 21 }), 400);
    expect(state.atoms).toHaveLength(5);
    // Some came and went; the count never moved.
    expect(state.nextId).toBeGreaterThan(5);
  });

  it("leaves the pane emptier at some point than it started", () => {
    let state = createAtomField({ bounds: BOUNDS, count: 5, seed: 21 });
    let sawDormant = false;
    for (let i = 0; i < 400; i += 1) {
      state = stepAtoms(state, BOUNDS);
      if (state.atoms.some((placed) => placed.dormantSteps > 0)) sawDormant = true;
    }
    expect(sawDormant).toBe(true);
  });
});

describe("stepAtoms collisions", () => {
  const meeting = (): Atom[] => [
    atom({ id: 1, column: 10, row: 4, columnVelocity: 0.6, rowVelocity: 0 }),
    atom({ id: 2, column: 12, row: 4, columnVelocity: -0.6, rowVelocity: 0 }),
  ];

  it("turns both atoms toxic when their glyphs touch", () => {
    const after = stepAtoms(field(meeting()), BOUNDS).atoms;
    expect(after[0]!.hotSteps).toBe(COLLISION_STEPS);
    expect(after[1]!.hotSteps).toBe(COLLISION_STEPS);
  });

  it("pushes them apart so the pair does not stay green forever", () => {
    const after = stepAtoms(field(meeting()), BOUNDS).atoms;
    expect(after[0]!.columnVelocity).toBeLessThan(0);
    expect(after[1]!.columnVelocity).toBeGreaterThan(0);
  });

  it("counts the green window down and lets it expire", () => {
    const lit = field([
      atom({ hotSteps: COLLISION_STEPS, columnVelocity: 0, rowVelocity: 0 }),
    ]);
    const cooling = run(lit, COLLISION_STEPS - 1);
    expect(cooling.atoms[0]!.hotSteps).toBe(1);
    expect(stepAtoms(cooling, BOUNDS).atoms[0]!.hotSteps).toBe(0);
  });

  it("does not leave a collided pair green for the rest of the run", () => {
    // They part over a couple of steps rather than one — the glyph is
    // three cells wide and they are half a cell apart when they meet —
    // so the flash outlasts the touch, then goes out.
    const settled = run(field(meeting()), 12);
    expect(settled.atoms.every((placed) => placed.hotSteps === 0)).toBe(true);
  });

  it("leaves atoms on different rows alone", () => {
    const apart = [
      atom({ id: 1, column: 10, row: 2, columnVelocity: 0.6, rowVelocity: 0 }),
      atom({ id: 2, column: 12, row: 6, columnVelocity: -0.6, rowVelocity: 0 }),
    ];
    const after = stepAtoms(field(apart), BOUNDS).atoms;
    expect(after.every((placed) => placed.hotSteps === 0)).toBe(true);
  });

  it("leaves atoms whose glyphs clear each other alone", () => {
    const apart = [
      atom({ id: 1, column: 10, row: 4, columnVelocity: 0, rowVelocity: 0 }),
      atom({ id: 2, column: 10 + ATOM_WIDTH, row: 4, columnVelocity: 0, rowVelocity: 0 }),
    ];
    const after = stepAtoms(field(apart), BOUNDS).atoms;
    expect(after.every((placed) => placed.hotSteps === 0)).toBe(true);
  });
});
