import { describe, expect, it } from "vitest";

import {
  createStrip,
  CRITTER_FRAMES,
  CRITTER_HATCH,
  CRITTER_WIDTH,
  EGG_FRAMES,
  PALETTE,
  renderStrip,
  runsOf,
  SCENE_PIXEL_ROWS,
  stepStrip,
  STRIP_ROWS,
  stripToText,
  type StripState,
} from "./swarm-critters.js";

function run(state: StripState, ticks: number, target: number, width = state.width): StripState {
  let s = state;
  for (let i = 0; i < ticks; i += 1) s = stepStrip(s, target, width);
  return s;
}

describe("sprites", () => {
  it("are rectangular, six rows tall, and only use palette colours", () => {
    for (const sprite of [...CRITTER_FRAMES, CRITTER_HATCH, ...EGG_FRAMES]) {
      expect(sprite).toHaveLength(SCENE_PIXEL_ROWS);
      const w = sprite[0]!.length;
      for (const row of sprite) {
        expect(row).toHaveLength(w);
        for (const px of row) {
          if (px !== ".") expect(PALETTE[px]).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("walk frames differ only in the legs, so the body does not jitter", () => {
    const [a, b] = CRITTER_FRAMES;
    // Body rows (2–4) identical, leg rows (1, 5) move.
    expect(a![2]).toBe(b![2]);
    expect(a![3]).toBe(b![3]);
    expect(a![4]).toBe(b![4]);
    expect(a![5]).not.toBe(b![5]);
  });
});

describe("createStrip", () => {
  it("seats eggs inside the pane and spreads existing critters out", () => {
    const s = createStrip(60, 3);
    expect(s.eggs.length).toBe(3);
    for (const egg of s.eggs) {
      expect(egg.x).toBeGreaterThanOrEqual(0);
      expect(egg.x).toBeLessThanOrEqual(60 - 5);
      expect(egg.stage).toBe(0);
    }
    expect(s.critters.map((c) => c.hatching)).toEqual([null, null, null]);
    const xs = s.critters.map((c) => c.x);
    expect(new Set(xs).size).toBe(3);
    expect(Math.max(...xs)).toBeLessThanOrEqual(60 - CRITTER_WIDTH);
  });

  it("uses fewer eggs in a narrow pane", () => {
    expect(createStrip(30, 0).eggs.length).toBe(1);
    expect(createStrip(100, 0).eggs.length).toBe(3);
  });
});

describe("stepStrip", () => {
  it("hatches a critter from an egg when a bot is added, then regrows the egg", () => {
    let s = createStrip(60, 0);
    expect(s.critters).toHaveLength(0);
    s = stepStrip(s, 1, 60);
    // First tick: an egg starts cracking, nothing has hatched yet.
    expect(s.eggs.filter((e) => e.stage === 1)).toHaveLength(1);
    expect(s.critters).toHaveLength(0);
    s = run(s, 8, 1);
    // Cracked through: one critter, sitting at its egg first.
    expect(s.critters).toHaveLength(1);
    const egg = s.eggs.find((e) => e.stage === 3)!;
    expect(egg).toBeDefined();
    expect(Math.abs(s.critters[0]!.x - (egg.x - 2))).toBeLessThanOrEqual(0);
    // Eventually it runs, and the egg grows back.
    s = run(s, 40, 1);
    expect(s.critters[0]!.hatching).toBeNull();
    expect(s.eggs.every((e) => e.stage === 0)).toBe(true);
    expect(s.critters).toHaveLength(1);
  });

  it("hatches one critter per added bot, never more than the target", () => {
    let s = createStrip(80, 1);
    s = run(s, 60, 4);
    expect(s.critters).toHaveLength(4);
    s = run(s, 60, 4);
    expect(s.critters).toHaveLength(4);
  });

  it("still reaches the target when every egg is spent", () => {
    let s = createStrip(30, 0); // one egg
    s = run(s, 10, 1);
    expect(s.critters).toHaveLength(1);
    // Ask for two more while the single egg is regrowing.
    s = run(s, 6, 3);
    expect(s.critters.length).toBeGreaterThanOrEqual(2);
    s = run(s, 60, 3);
    expect(s.critters).toHaveLength(3);
  });

  it("sends the youngest critter underground when a bot is removed", () => {
    let s = createStrip(60, 3);
    const ids = s.critters.map((c) => c.id);
    s = stepStrip(s, 2, 60);
    expect(s.critters.map((c) => c.id)).toEqual(ids.slice(0, 2));
    s = run(s, 3, 0);
    expect(s.critters).toHaveLength(0);
  });

  it("keeps runners inside the pane and turns them around at the edges", () => {
    let s = createStrip(40, 2);
    for (let i = 0; i < 200; i += 1) {
      s = stepStrip(s, 2, 40);
      for (const c of s.critters) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThanOrEqual(40 - CRITTER_WIDTH);
      }
    }
    // Both directions were used at some point.
    const dirs = new Set<number>();
    let t = createStrip(40, 1);
    for (let i = 0; i < 100; i += 1) {
      t = stepStrip(t, 1, 40);
      dirs.add(t.critters[0]!.dir);
    }
    expect(dirs).toEqual(new Set([1, -1]));
  });

  it("re-seats eggs when the pane is resized", () => {
    let s = createStrip(90, 0);
    s = stepStrip(s, 0, 40);
    expect(s.width).toBe(40);
    for (const egg of s.eggs) expect(egg.x).toBeLessThanOrEqual(40 - 5);
  });
});

describe("renderStrip", () => {
  it("produces exactly three text rows of pane width", () => {
    const s = createStrip(50, 2);
    const rows = renderStrip(s);
    expect(rows).toHaveLength(STRIP_ROWS);
    for (const row of rows) expect(row).toHaveLength(50);
  });

  it("stacks two pixels per cell with half-blocks and leaves gaps transparent", () => {
    const s = createStrip(50, 1);
    const cells = renderStrip(s).flat();
    const glyphs = new Set(cells.map((c) => c.ch));
    expect([...glyphs].every((g) => g === " " || g === "▀" || g === "▄")).toBe(true);
    // A `▀` over a filled bottom pixel carries both colours.
    expect(cells.some((c) => c.ch === "▀" && c.fg && c.bg)).toBe(true);
    // Blank cells carry no colour at all so the terminal background shows.
    expect(cells.filter((c) => c.ch === " ").every((c) => !c.fg && !c.bg)).toBe(true);
  });

  it("draws every egg and every critter somewhere on the strip", () => {
    const s = createStrip(60, 2);
    const text = stripToText(s).join("\n");
    // Rough coverage: eggs are 5 wide, critters 10 — plenty of ink.
    expect(text.replace(/\s/g, "").length).toBeGreaterThan(30);
  });

  it("merges runs of identical styling", () => {
    const s = createStrip(50, 0);
    const rows = renderStrip(s);
    for (const row of rows) {
      const runs = runsOf(row);
      expect(runs.map((r) => r.text).join("")).toHaveLength(50);
      for (let i = 1; i < runs.length; i += 1) {
        const a = runs[i - 1]!;
        const b = runs[i]!;
        expect(a.fg === b.fg && a.bg === b.bg).toBe(false);
      }
    }
  });
});
