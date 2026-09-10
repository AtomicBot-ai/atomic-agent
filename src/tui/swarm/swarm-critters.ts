/**
 * The Swarm tab's hatchery strip: a row of eggs along the bottom of the
 * pane, and one small critter per connected bot scurrying left and right
 * above them. Adding a bot cracks an egg and a new critter climbs out;
 * removing one sends the youngest critter back underground.
 *
 * Pure module: sprite data, the tick reducer, and a renderer that turns
 * the 6-pixel-tall scene into 3 text rows of half-block cells. The Ink
 * component in `zergling-strip.tsx` owns the timer and paints the cells.
 * Everything here is deterministic given `(state, tick)` so it can be
 * pinned by tests without a terminal.
 *
 * The art is original pixel work in the spirit of a classic RTS critter —
 * a hunched six-legged runner with raised sickle claws — not a copy of
 * any game's sprite.
 */

/** One picture element: `.` is transparent, letters index `PALETTE`. */
export type SpriteRows = readonly string[];

export const PALETTE: Readonly<Record<string, string>> = {
  // critter
  P: "#7a3e9d", // carapace, violet
  D: "#4a1f66", // spines / shadow
  B: "#a5652e", // head, chitin brown
  E: "#ffd23f", // eye
  L: "#3a1a4d", // legs and claws
  // egg
  G: "#6b2d8a", // shell
  V: "#b46bd9", // vein highlight
  K: "#1d0b2a", // crack
  // creep left where an egg hatched
  C: "#3b1a52",
};

/** Six pixel rows tall (three text rows), ten wide, facing right. */
export const CRITTER_FRAMES: readonly SpriteRows[] = [
  [
    "..........",
    "....DD..L.",
    "..PPPPPDL.",
    ".PPPPPPBBE",
    ".P..PP..BB",
    "..L..L..L.",
  ],
  [
    "..........",
    "....DD.L..",
    "..PPPPPDL.",
    ".PPPPPPBBE",
    ".P..PP..BB",
    ".L..L..L..",
  ],
];

/** A critter climbing out: low, legs tucked, eye already open. */
export const CRITTER_HATCH: SpriteRows = [
  "..........",
  "..........",
  "..........",
  "...PPPPBE.",
  "..PPPPPBB.",
  "...L..L...",
];

export const EGG_FRAMES: readonly SpriteRows[] = [
  // intact
  ["..GG.", ".GGGG", ".GVGG", "GGGGG", "GGGGG", ".GGG."],
  // cracked
  ["..GG.", ".GKGG", ".GVKG", "GGGKG", "GGKGG", ".GGG."],
  // split open
  ["..K..", ".GK.G", ".GVKG", "GGK.G", "GKGGG", ".GGG."],
  // spent: a splat of creep
  [".....", ".....", ".....", ".....", "..C..", ".CCC."],
];

export const CRITTER_WIDTH = CRITTER_FRAMES[0]![0]!.length;
export const EGG_WIDTH = EGG_FRAMES[0]![0]!.length;
export const SCENE_PIXEL_ROWS = 6;
/** Text rows the strip occupies. */
export const STRIP_ROWS = SCENE_PIXEL_ROWS / 2;
/** Narrowest pane the strip bothers to draw in. */
export const MIN_STRIP_WIDTH = 24;

/** Ticks an egg spends cracking before the critter climbs out. */
const CRACK_TICKS = 4;
/** Ticks a hatchling sits before it starts running. */
const HATCH_TICKS = 3;
/** Ticks a spent egg waits before a fresh one grows in its place. */
const REGROW_TICKS = 28;
/** Eggs kept along the bottom, capped by width. */
const EGG_SLOTS = 3;

export interface EggState {
  x: number;
  /** 0 intact · 1–2 cracking · 3 spent (regrowing). */
  stage: 0 | 1 | 2 | 3;
  /** Ticks left in the current stage. */
  wait: number;
}

export interface CritterState {
  id: number;
  x: number;
  dir: 1 | -1;
  /** `null` once running; otherwise ticks left sitting at the egg. */
  hatching: number | null;
}

export interface StripState {
  width: number;
  tick: number;
  nextId: number;
  eggs: EggState[];
  critters: CritterState[];
}

/** Egg positions: evenly spread, never overlapping the pane edges. */
function eggSlots(width: number): number[] {
  const slots = Math.max(1, Math.min(EGG_SLOTS, Math.floor(width / 16)));
  const usable = width - EGG_WIDTH;
  return Array.from({ length: slots }, (_, i) =>
    Math.round(((i + 1) * usable) / (slots + 1)),
  );
}

/**
 * A strip with `count` critters already running (bots that existed when
 * the tab opened) and every egg intact.
 */
export function createStrip(width: number, count: number): StripState {
  const eggs: EggState[] = eggSlots(width).map((x) => ({ x, stage: 0, wait: 0 }));
  const span = Math.max(1, width - CRITTER_WIDTH);
  const critters: CritterState[] = Array.from({ length: Math.max(0, count) }, (_, i) => ({
    id: i + 1,
    // Spread the starting pack out and alternate direction so they do
    // not march in lockstep.
    x: Math.round(((i + 1) * span) / (count + 1)),
    dir: i % 2 === 0 ? 1 : -1,
    hatching: null,
  }));
  return { width, tick: 0, nextId: critters.length + 1, eggs, critters };
}

/**
 * Advance one tick towards `targetCount` critters. Deterministic: the
 * only randomness-like variety comes from `tick` parity.
 */
export function stepStrip(state: StripState, targetCount: number, width: number): StripState {
  const tick = state.tick + 1;
  let eggs = state.eggs;
  if (width !== state.width) {
    // Pane resized: re-seat eggs, keep their stage.
    const slots = eggSlots(width);
    eggs = slots.map((x, i): EggState => {
      const prev = state.eggs[i];
      return prev ? { ...prev, x } : { x, stage: 0, wait: 0 };
    });
  }
  let nextId = state.nextId;
  const span = Math.max(0, width - CRITTER_WIDTH);

  // Move the runners; hatchlings sit still until their timer runs out.
  let critters: CritterState[] = state.critters.map((c) => {
    if (c.hatching !== null) {
      return c.hatching <= 1 ? { ...c, hatching: null } : { ...c, hatching: c.hatching - 1 };
    }
    let x = c.x + c.dir;
    let dir = c.dir;
    if (x < 0) {
      x = 0;
      dir = 1;
    } else if (x > span) {
      x = span;
      dir = -1;
    }
    return { ...c, x, dir };
  });

  // Egg timers.
  eggs = eggs.map((e) => {
    if (e.wait > 1) return { ...e, wait: e.wait - 1 };
    if (e.wait === 1) {
      if (e.stage === 1) return { ...e, stage: 2, wait: CRACK_TICKS };
      if (e.stage === 2) return { ...e, stage: 3, wait: REGROW_TICKS }; // hatched below
      if (e.stage === 3) return { ...e, stage: 0, wait: 0 };
    }
    return e;
  });

  const want = Math.max(0, targetCount);
  const pending = eggs.filter((e) => e.stage === 1 || e.stage === 2).length;
  if (critters.length + pending < want) {
    // Crack the first intact egg. If every egg is busy or spent, hatch
    // from thin air so the count never lags the truth for long.
    const idx = eggs.findIndex((e) => e.stage === 0);
    if (idx >= 0) {
      eggs = eggs.map((e, i) => (i === idx ? { ...e, stage: 1, wait: CRACK_TICKS } : e));
    } else if (pending === 0) {
      critters = [
        ...critters,
        { id: nextId++, x: Math.min(span, Math.max(0, Math.floor(width / 2))), dir: 1, hatching: null },
      ];
    }
  }
  // An egg that just finished splitting releases its critter.
  for (const [i, e] of eggs.entries()) {
    const before = state.eggs[i];
    if (e.stage === 3 && before?.stage === 2 && critters.length < want) {
      critters = [
        ...critters,
        {
          id: nextId++,
          x: Math.min(span, Math.max(0, e.x - 2)),
          dir: e.x > width / 2 ? -1 : 1,
          hatching: HATCH_TICKS,
        },
      ];
    }
  }
  while (critters.length > want) {
    // The youngest goes back underground first.
    critters = critters.slice(0, -1);
  }
  return { width, tick, nextId, eggs, critters };
}

export interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
}

/** Paint one sprite into the pixel buffer at column `x`, mirrored when `dir` is -1. */
function blit(
  buffer: (string | null)[][],
  sprite: SpriteRows,
  x: number,
  dir: 1 | -1,
  width: number,
): void {
  const w = sprite[0]!.length;
  for (let r = 0; r < sprite.length && r < SCENE_PIXEL_ROWS; r += 1) {
    const row = sprite[r]!;
    for (let c = 0; c < w; c += 1) {
      const px = row[dir === 1 ? c : w - 1 - c]!;
      if (px === ".") continue;
      const col = x + c;
      if (col < 0 || col >= width) continue;
      buffer[r]![col] = PALETTE[px] ?? null;
    }
  }
}

/**
 * Render the scene as `STRIP_ROWS` rows of cells. Each text cell stacks
 * two pixels: `▀` paints the top pixel in `fg` over the bottom pixel in
 * `bg`; a lone bottom pixel is `▄`; empty is a plain space so the
 * terminal's own background shows through.
 */
export function renderStrip(state: StripState): Cell[][] {
  const { width } = state;
  const buffer: (string | null)[][] = Array.from({ length: SCENE_PIXEL_ROWS }, () =>
    Array.from({ length: width }, () => null),
  );
  for (const egg of state.eggs) blit(buffer, EGG_FRAMES[egg.stage]!, egg.x, 1, width);
  for (const c of state.critters) {
    const sprite =
      c.hatching !== null ? CRITTER_HATCH : CRITTER_FRAMES[(state.tick + c.id) % 2]!;
    blit(buffer, sprite, c.x, c.dir, width);
  }
  const rows: Cell[][] = [];
  for (let r = 0; r < SCENE_PIXEL_ROWS; r += 2) {
    const row: Cell[] = [];
    for (let col = 0; col < width; col += 1) {
      const top = buffer[r]![col];
      const bottom = buffer[r + 1]![col];
      if (top && bottom) row.push({ ch: "▀", fg: top, bg: bottom });
      else if (top) row.push({ ch: "▀", fg: top });
      else if (bottom) row.push({ ch: "▄", fg: bottom });
      else row.push({ ch: " " });
    }
    rows.push(row);
  }
  return rows;
}

/** Merge runs of identically styled cells so Ink gets few `<Text>` nodes. */
export function runsOf(row: readonly Cell[]): Array<{ text: string; fg?: string; bg?: string }> {
  const runs: Array<{ text: string; fg?: string; bg?: string }> = [];
  for (const cell of row) {
    const last = runs.at(-1);
    if (last && last.fg === cell.fg && last.bg === cell.bg) {
      last.text += cell.ch;
    } else {
      const run: { text: string; fg?: string; bg?: string } = { text: cell.ch };
      if (cell.fg !== undefined) run.fg = cell.fg;
      if (cell.bg !== undefined) run.bg = cell.bg;
      runs.push(run);
    }
  }
  return runs;
}

/** Plain-text preview (no colour) — handy for tests and debugging. */
export function stripToText(state: StripState): string[] {
  return renderStrip(state).map((row) => row.map((c) => c.ch).join(""));
}
