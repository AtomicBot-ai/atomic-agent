import { describe, expect, it } from "vitest";
import { fitImageCells, MAX_IMAGE_COLS, MAX_IMAGE_ROWS } from "./fit-image-cells.js";

describe("fitImageCells", () => {
  it("fits a square picture by height (cells are twice as tall as wide)", () => {
    expect(fitImageCells(1024, 1024)).toEqual({ cols: 24, rows: MAX_IMAGE_ROWS });
  });

  it("fits a wide picture by width", () => {
    expect(fitImageCells(1344, 768)).toEqual({ cols: MAX_IMAGE_COLS, rows: 11 });
  });

  it("fits a tall picture by height", () => {
    const box = fitImageCells(768, 1344);
    expect(box.rows).toBe(MAX_IMAGE_ROWS);
    expect(box.cols).toBe(14);
  });

  it("never exceeds the box it is given", () => {
    for (const [w, h] of [[4000, 100], [100, 4000], [1, 1], [5000, 5000]] as const) {
      const box = fitImageCells(w, h, { cols: 19, rows: 12 });
      expect(box.cols).toBeGreaterThanOrEqual(1);
      expect(box.rows).toBeGreaterThanOrEqual(1);
      expect(box.cols).toBeLessThanOrEqual(19);
      expect(box.rows).toBeLessThanOrEqual(12);
    }
  });

  it("does not blow a tiny picture up", () => {
    expect(fitImageCells(16, 16)).toEqual({ cols: 2, rows: 1 });
  });

  it("survives a nonsense size", () => {
    expect(fitImageCells(0, 0)).toEqual({ cols: 1, rows: 1 });
  });
});
