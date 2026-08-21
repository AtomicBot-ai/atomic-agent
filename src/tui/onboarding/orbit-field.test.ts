import { describe, expect, it } from "vitest";
import { computeOrbitField, orbitRowMap, CELL_ASPECT } from "./orbit-field.js";

const base = {
  columns: 100,
  rows: 40,
  center: { column: 50, row: 20 },
  radius: 22,
  count: 12,
};

describe("computeOrbitField", () => {
  it("draws an ellipse, not a circle — a cell is taller than it is wide", () => {
    const cells = computeOrbitField(base);
    const columns = cells.map((c) => c.column);
    const rows = cells.map((c) => c.row);
    const columnSpread = Math.max(...columns) - Math.min(...columns);
    const rowSpread = Math.max(...rows) - Math.min(...rows);
    expect(columnSpread).toBeGreaterThan(rowSpread);
    expect(columnSpread / rowSpread).toBeCloseTo(CELL_ASPECT, 0);
  });

  it("keeps every cell inside the viewport", () => {
    const cells = computeOrbitField({ ...base, radius: 400 });
    for (const cell of cells) {
      expect(cell.column).toBeGreaterThanOrEqual(0);
      expect(cell.column).toBeLessThan(base.columns);
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(base.rows);
    }
  });

  it("never returns the same cell twice", () => {
    const cells = computeOrbitField({ ...base, count: 200 });
    const keys = new Set(cells.map((c) => `${c.column},${c.row}`));
    expect(keys.size).toBe(cells.length);
  });

  it("stays out of reserved bands", () => {
    const cells = computeOrbitField({
      ...base,
      reserved: [{ top: 18, bottom: 22 }],
    });
    expect(cells.every((c) => c.row < 18 || c.row > 22)).toBe(true);
  });

  it("draws nothing for a zero count or a zero radius", () => {
    expect(computeOrbitField({ ...base, count: 0 })).toEqual([]);
    expect(computeOrbitField({ ...base, radius: 0 })).toEqual([]);
  });

  it("groups by row for the renderer", () => {
    const map = orbitRowMap([
      { column: 9, row: 2 },
      { column: 3, row: 2 },
      { column: 5, row: 7 },
    ]);
    expect(map.get(2)).toEqual([3, 9]);
    expect(map.get(7)).toEqual([5]);
  });
});
