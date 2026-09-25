import { describe, expect, it } from "vitest";
import {
  countChipRows,
  layoutChipRows,
  stripWidth,
} from "./hotkey-chip-rows.js";
import type { HotkeyChip } from "./hotkey-chips.js";

/**
 * The packing, away from Ink. `hotkey-hint.test.tsx` asserts what the
 * operator sees; this file asserts the rules that produce it, because
 * "wrap, then shed, then clip" is an ordering and an ordering is easiest
 * to get wrong at the boundaries.
 */
const chip = (key: string, label: string, shed?: number): HotkeyChip =>
  shed === undefined ? { key, label } : { key, label, shed };

/** Four chips of 10 columns each: `[ab] label` is 3 + 2 + 5. */
const TEN = ["a", "b", "c", "d"].map((k) => chip(k, "label"));

describe("stripWidth", () => {
  it("counts a single chip as bracket, key, bracket, space, label", () => {
    expect(stripWidth([chip("esc", "menu")])).toBe(3 + 3 + 4);
  });

  it("counts nothing for an empty row", () => {
    expect(stripWidth([])).toBe(0);
  });

  it("adds one separator between each pair, never a trailing one", () => {
    const one = stripWidth([TEN[0]!]);
    const two = stripWidth([TEN[0]!, TEN[1]!]);
    const three = stripWidth([TEN[0]!, TEN[1]!, TEN[2]!]);
    expect(two - one).toBe(three - two);
  });
});

describe("layoutChipRows", () => {
  it("keeps one row when the chips fit", () => {
    const rows = layoutChipRows(TEN, 200, 4);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(4);
  });

  it("wraps rather than shedding when a row is available", () => {
    const rows = layoutChipRows(TEN, stripWidth(TEN) - 1, 4);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.flat()).toHaveLength(4);
  });

  it("never exceeds the width on a row it chose to break", () => {
    for (let width = 12; width <= 60; width += 1) {
      for (const row of layoutChipRows(TEN, width, 4)) {
        if (row.length > 1) expect(stripWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the declared order across the break", () => {
    const rows = layoutChipRows(TEN, 24, 4);
    expect(rows.flat().map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("sheds the lowest rank first once the rows run out", () => {
    const chips = [
      chip("keep", "essential"),
      chip("go2", "second", 2),
      chip("go1", "first", 1),
    ];
    const rows = layoutChipRows(chips, 20, 1);
    const keys = rows.flat().map((c) => c.key);
    expect(keys).toContain("keep");
    expect(keys).not.toContain("go1");
  });

  it("sheds no further than it has to", () => {
    // Two rows can hold what one cannot, so the rankable chip survives a
    // width that a one-row budget would have cost it.
    const chips = [chip("keep", "essential"), chip("go", "rankable", 1)];
    const width = stripWidth(chips) - 1;
    expect(layoutChipRows(chips, width, 1).flat()).toHaveLength(1);
    expect(layoutChipRows(chips, width, 2).flat()).toHaveLength(2);
  });

  it("clips rather than dropping an essential that cannot fit", () => {
    const chips = [chip("a", "essential"), chip("b", "essential")];
    const rows = layoutChipRows(chips, 4, 1);
    expect(rows).toHaveLength(1);
    // Both are still on the row; `truncate-end` is what the terminal
    // does with the overflow.
    expect(rows[0]).toHaveLength(2);
  });

  it("treats a budget below one row as one row", () => {
    expect(layoutChipRows(TEN, 20, 0)).toHaveLength(1);
    expect(layoutChipRows(TEN, 20, -3)).toHaveLength(1);
  });

  it("gives an empty chip list no rows at all", () => {
    expect(layoutChipRows([], 80, 3)).toEqual([]);
    expect(countChipRows([], 80, 3)).toBe(0);
  });

  it("survives a zero width without looping", () => {
    expect(layoutChipRows(TEN, 0, 2).flat()).toHaveLength(4);
  });

  it("counts the rows it lays out", () => {
    for (const width of [12, 20, 33, 47, 200]) {
      expect(countChipRows(TEN, width, 3)).toBe(
        layoutChipRows(TEN, width, 3).length,
      );
    }
  });
});
