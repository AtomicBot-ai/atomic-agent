import { CELL_ASPECT } from "./orbit-field.js";

/**
 * The ambient field of atoms drawn in the empty space under the download
 * screen's progress bars.
 *
 * A multi-gigabyte pull is a wait measured in minutes, and a bar that
 * only visibly moves every few seconds reads as a hung program. The
 * atoms give the screen a pulse without pretending to be progress:
 * nothing here is derived from the download, and nothing here is fast.
 * They drift, bounce off the edges the way a DVD logo does, wink out and
 * reappear somewhere else, and once in a long while two of them meet.
 *
 * Pure, seeded and React-free, so the whole simulation is a table test
 * rather than something you have to sit and watch to believe. The owner
 * of the interval lives in `use-atom-field.ts`; the drawing lives in
 * `atom-field-rows.ts`.
 */

/**
 * The atom, as a glyph: a nucleus inside its shell. Picked over the
 * brand cross because the cross is already the intro splash's orbit
 * glyph, and over a bare bullet because a single dot in an empty pane
 * reads as a stuck cursor rather than as an object.
 */
export const ATOM_GLYPH = "(•)";
export const ATOM_WIDTH = 3;

/** One step per this many milliseconds. Ambience, not animation. */
export const ATOM_STEP_MS = 620;

/** How long two atoms stay toxic green after they touch. */
export const COLLISION_STEPS = 4;

/**
 * Columns travelled per step. Three speeds rather than one: atoms that
 * all move at the same rate keep their relative positions forever and
 * never meet, so a collision would be impossible instead of rare.
 */
const SPEEDS: readonly number[] = [0.4, 0.6, 0.9];

/** Steps an atom lives before it retires, and stays away before it returns. */
const LIFE_MIN = 16;
const LIFE_MAX = 44;
const DORMANT_MIN = 2;
const DORMANT_MAX = 7;

export interface Atom {
  readonly id: number;
  /** Fractional cell coordinates; the renderer rounds them. */
  readonly column: number;
  readonly row: number;
  readonly columnVelocity: number;
  readonly rowVelocity: number;
  /** Steps left of the collision colour. Zero on a normal atom. */
  readonly hotSteps: number;
  /** Steps left before this atom retires. */
  readonly lifeSteps: number;
  /** Steps left off screen before it comes back elsewhere. Zero while visible. */
  readonly dormantSteps: number;
}

export interface AtomBounds {
  readonly columns: number;
  readonly rows: number;
}

export interface AtomFieldState {
  readonly atoms: readonly Atom[];
  /** Carried in state rather than in a closure: every step stays pure. */
  readonly seed: number;
  readonly step: number;
  readonly nextId: number;
}

/** mulberry32. Small, fast and stable across Node versions. */
function nextRandom(seed: number): { value: number; seed: number } {
  const advanced = (seed + 0x6d2b79f5) >>> 0;
  let t = advanced;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: advanced };
}

function maxColumnFor(bounds: AtomBounds): number {
  return Math.max(0, bounds.columns - ATOM_WIDTH);
}

function maxRowFor(bounds: AtomBounds): number {
  return Math.max(0, bounds.rows - 1);
}

/** A fresh atom somewhere in the field, with its own speed and lifespan. */
function spawnAtom(
  id: number,
  seed: number,
  bounds: AtomBounds,
): { atom: Atom; seed: number } {
  let cursor = seed;
  const roll = (): number => {
    const rolled = nextRandom(cursor);
    cursor = rolled.seed;
    return rolled.value;
  };
  const speed = SPEEDS[Math.floor(roll() * SPEEDS.length)] ?? SPEEDS[0]!;
  const column = roll() * maxColumnFor(bounds);
  const row = roll() * maxRowFor(bounds);
  const columnVelocity = roll() < 0.5 ? -speed : speed;
  // Divided by the cell aspect so the drift reads as a diagonal rather
  // than as a plunge: a cell is far taller than it is wide, so equal
  // steps in rows and columns are not equal distances on screen.
  const rowVelocity = (roll() < 0.5 ? -speed : speed) / CELL_ASPECT;
  const lifeSteps = LIFE_MIN + Math.floor(roll() * (LIFE_MAX - LIFE_MIN + 1));
  return {
    atom: { id, column, row, columnVelocity, rowVelocity, hotSteps: 0, lifeSteps, dormantSteps: 0 },
    seed: cursor,
  };
}

export function createAtomField(options: {
  bounds: AtomBounds;
  count: number;
  seed: number;
}): AtomFieldState {
  let seed = options.seed;
  const atoms: Atom[] = [];
  for (let id = 0; id < Math.max(0, options.count); id += 1) {
    const spawned = spawnAtom(id, seed, options.bounds);
    seed = spawned.seed;
    atoms.push(spawned.atom);
  }
  return { atoms, seed, step: 0, nextId: atoms.length };
}

/**
 * Move one coordinate and bounce it off its wall. The clamp is not
 * redundant with the reflection: a terminal that shrinks under a running
 * field leaves atoms outside the new bounds, and one reflection is not
 * enough to bring them back.
 */
function reflect(
  position: number,
  velocity: number,
  max: number,
): { position: number; velocity: number } {
  if (max <= 0) return { position: 0, velocity };
  let next = position + velocity;
  let bounced = velocity;
  if (next < 0) {
    next = -next;
    bounced = -velocity;
  } else if (next > max) {
    next = 2 * max - next;
    bounced = -velocity;
  }
  return { position: Math.min(max, Math.max(0, next)), velocity: bounced };
}

function moveAtom(atom: Atom, bounds: AtomBounds): Atom {
  const horizontal = reflect(atom.column, atom.columnVelocity, maxColumnFor(bounds));
  const vertical = reflect(atom.row, atom.rowVelocity, maxRowFor(bounds));
  return {
    ...atom,
    column: horizontal.position,
    row: vertical.position,
    columnVelocity: horizontal.velocity,
    rowVelocity: vertical.velocity,
    hotSteps: Math.max(0, atom.hotSteps - 1),
    lifeSteps: atom.lifeSteps - 1,
  };
}

/**
 * Mark every touching pair and push the two apart.
 *
 * Parting them matters as much as the colour: two atoms left on top of
 * each other would re-collide on every step from then on, and a field
 * where half the atoms are permanently green is a bug, not an event.
 */
function collide(atoms: Atom[]): Atom[] {
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const left = atoms[i];
      const right = atoms[j];
      if (!left || !right) continue;
      if (left.dormantSteps > 0 || right.dormantSteps > 0) continue;
      if (Math.round(left.row) !== Math.round(right.row)) continue;
      if (Math.abs(Math.round(left.column) - Math.round(right.column)) >= ATOM_WIDTH) {
        continue;
      }
      const leftIsLeading = left.column <= right.column;
      atoms[i] = {
        ...left,
        hotSteps: COLLISION_STEPS,
        columnVelocity: leftIsLeading
          ? -Math.abs(left.columnVelocity)
          : Math.abs(left.columnVelocity),
      };
      atoms[j] = {
        ...right,
        hotSteps: COLLISION_STEPS,
        columnVelocity: leftIsLeading
          ? Math.abs(right.columnVelocity)
          : -Math.abs(right.columnVelocity),
      };
    }
  }
  return atoms;
}

/** One tick of the field: move, age, retire, respawn, then collide. */
export function stepAtoms(state: AtomFieldState, bounds: AtomBounds): AtomFieldState {
  let seed = state.seed;
  let nextId = state.nextId;
  const atoms: Atom[] = [];
  for (const atom of state.atoms) {
    if (atom.dormantSteps > 1) {
      atoms.push({ ...atom, dormantSteps: atom.dormantSteps - 1 });
      continue;
    }
    if (atom.dormantSteps === 1) {
      // A returning atom gets a new id: it is a different atom in the
      // same slot, and the renderer's keys should say so.
      const spawned = spawnAtom(nextId, seed, bounds);
      seed = spawned.seed;
      nextId += 1;
      atoms.push(spawned.atom);
      continue;
    }
    if (atom.lifeSteps <= 1) {
      const rolled = nextRandom(seed);
      seed = rolled.seed;
      const span = DORMANT_MAX - DORMANT_MIN + 1;
      atoms.push({
        ...atom,
        lifeSteps: 0,
        hotSteps: 0,
        dormantSteps: DORMANT_MIN + Math.floor(rolled.value * span),
      });
      continue;
    }
    atoms.push(moveAtom(atom, bounds));
  }
  return { atoms: collide(atoms), seed, step: state.step + 1, nextId };
}
