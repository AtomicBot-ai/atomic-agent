import { describe, expect, it } from "vitest";
import {
  computeChatViewportRows,
  computeChatWidth,
  computeSidebarRowBudget,
  computeSidebarWidth,
  isSidebarVisible,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_MIN_WIDTH,
} from "./layout.js";

describe("isSidebarVisible", () => {
  it("collapses the rail one column below the threshold", () => {
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS - 1)).toBe(false);
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS)).toBe(true);
  });
});

describe("computeSidebarWidth", () => {
  it("scales with the terminal between the two clamps", () => {
    expect(computeSidebarWidth(100)).toBe(25);
    expect(computeSidebarWidth(120)).toBe(30);
  });

  it("never leaves the [min, max] band", () => {
    expect(computeSidebarWidth(60)).toBe(SIDEBAR_MIN_WIDTH);
    expect(computeSidebarWidth(400)).toBe(SIDEBAR_MAX_WIDTH);
    for (let columns = 20; columns <= 400; columns += 1) {
      const width = computeSidebarWidth(columns);
      expect(width).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
      expect(width).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
    }
  });
});

describe("computeChatWidth", () => {
  it("only subtracts the rail once it is actually drawn", () => {
    expect(computeChatWidth(80)).toBe(78);
    expect(computeChatWidth(100)).toBe(100 - 2 - 25);
    expect(computeChatWidth(120)).toBe(120 - 2 - 30);
  });

  it("grows monotonically with the terminal", () => {
    let previous = 0;
    for (let columns = 40; columns <= 400; columns += 1) {
      const width = computeChatWidth(columns);
      expect(width).toBeGreaterThanOrEqual(0);
      // The rail appearing at 100 columns is the one allowed step back.
      if (columns !== SIDEBAR_MIN_COLUMNS) {
        expect(width).toBeGreaterThanOrEqual(previous);
      }
      previous = width;
    }
  });
});

describe("computeSidebarRowBudget", () => {
  it("splits the usable height roughly 2:1 in favour of sessions", () => {
    const budget = computeSidebarRowBudget(24);
    expect(budget.sessions).toBe(10);
    expect(budget.tasks).toBe(5);
    expect(computeSidebarRowBudget(16).sessions).toBe(6);
    expect(computeSidebarRowBudget(16).tasks).toBe(3);
  });

  it("keeps both panes alive on a very short window", () => {
    for (let rows = 4; rows <= 12; rows += 1) {
      const budget = computeSidebarRowBudget(rows);
      expect(budget.sessions).toBeGreaterThanOrEqual(1);
      expect(budget.tasks).toBeGreaterThanOrEqual(1);
    }
  });

  it("stops growing once the caps are reached", () => {
    expect(computeSidebarRowBudget(200)).toEqual({ sessions: 10, tasks: 5 });
  });
});

describe("computeChatViewportRows", () => {
  it("reserves the prompt chrome but never returns less than five rows", () => {
    expect(computeChatViewportRows(40)).toBe(32);
    expect(computeChatViewportRows(10)).toBe(4);
    expect(computeChatViewportRows(2)).toBe(4);
  });

  it("reserves more chrome on a narrow terminal, where it wraps", () => {
    expect(computeChatViewportRows(24, 45)).toBe(12);
    expect(computeChatViewportRows(24, 80)).toBe(16);
  });
});
