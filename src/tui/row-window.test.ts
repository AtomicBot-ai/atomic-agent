import { describe, expect, it } from "vitest";
import { computeRowWindow, computeWindowStart } from "./row-window.js";

describe("computeWindowStart", () => {
  it("returns 0 when the list fits the window", () => {
    expect(computeWindowStart(3, 5, 10)).toBe(0);
  });

  it("keeps the head visible while the cursor is within the first page", () => {
    expect(computeWindowStart(2, 20, 5)).toBe(0);
  });

  it("scrolls so the cursor stays on the last visible row", () => {
    expect(computeWindowStart(10, 20, 5)).toBe(6);
  });

  it("clamps the start at the tail of the list", () => {
    expect(computeWindowStart(19, 20, 5)).toBe(15);
  });

  it("is a no-op for a non-positive window size", () => {
    expect(computeWindowStart(5, 20, 0)).toBe(0);
  });
});

describe("computeRowWindow", () => {
  it("returns an empty window for an empty list", () => {
    expect(computeRowWindow(0, 0, 10)).toEqual({
      start: 0,
      count: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it("shows the whole list when it fits", () => {
    expect(computeRowWindow(4, 2, 10)).toEqual({
      start: 0,
      count: 4,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it("windows around the cursor and reports hidden counts", () => {
    expect(computeRowWindow(20, 10, 5)).toEqual({
      start: 6,
      count: 5,
      hiddenBefore: 6,
      hiddenAfter: 9,
    });
  });

  it("clamps an out-of-range cursor to the tail", () => {
    expect(computeRowWindow(20, 999, 5)).toEqual({
      start: 15,
      count: 5,
      hiddenBefore: 15,
      hiddenAfter: 0,
    });
  });

  it("treats a degenerate budget as at least one row", () => {
    const win = computeRowWindow(10, 4, 0);
    expect(win.count).toBe(1);
    expect(win.start).toBe(4);
  });
});
