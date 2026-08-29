import { describe, expect, it } from "vitest";
import {
  computeChatViewportRows,
  computeChatWidth,
  computeSidebarRowBudget,
  computeSidebarWidth,
  isSidebarVisible,
  SIDEBAR_CHROME_ROWS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_MIN_ROWS,
  SIDEBAR_MIN_WIDTH,
} from "./layout.js";

/** Comfortably taller than anything the rail needs. */
const TALL = 40;

describe("isSidebarVisible", () => {
  it("collapses the rail one column below the threshold", () => {
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS - 1, TALL)).toBe(false);
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS, TALL)).toBe(true);
  });

  it("collapses the rail one row below the threshold", () => {
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS, SIDEBAR_MIN_ROWS - 1)).toBe(
      false,
    );
    expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS, SIDEBAR_MIN_ROWS)).toBe(true);
  });

  it("hides the rail in a wide but short window", () => {
    // A split tmux pane, or a terminal docked under an editor: wide
    // enough for the rail and nowhere near tall enough for it.
    expect(isSidebarVisible(100, 8)).toBe(false);
    expect(isSidebarVisible(100, 5)).toBe(false);
    expect(isSidebarVisible(200, 4)).toBe(false);
  });

  it("hides the rail in a degenerate window", () => {
    expect(isSidebarVisible(1, 1)).toBe(false);
    expect(isSidebarVisible(0, 0)).toBe(false);
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
    expect(computeChatWidth(80, TALL)).toBe(78);
    expect(computeChatWidth(100, TALL)).toBe(100 - 2 - 25);
    expect(computeChatWidth(120, TALL)).toBe(120 - 2 - 30);
  });

  it("hands the chat column the full width when the rail is too short to draw", () => {
    expect(computeChatWidth(120, 8)).toBe(118);
  });

  it("grows monotonically with the terminal", () => {
    let previous = 0;
    for (let columns = 40; columns <= 400; columns += 1) {
      const width = computeChatWidth(columns, TALL);
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
    // The absolute numbers track SIDEBAR_CHROME_ROWS: the rail became the
    // app frame (brand lockup, version, Menu button) and so spends more of
    // the height on itself. What this pins is the 2:1 ratio, and that both
    // panes shrink together rather than one starving the other.
    // `+ new` moved onto the Sessions header and gave a row back; the
    // blank that lifts the Menu button off the rail's bottom edge took
    // it again. The brand mark then went to the guidelines' five rows,
    // and back down to three when the small mark was redrawn — which is
    // where these two rows came from.
    const budget = computeSidebarRowBudget(24);
    expect(budget.sessions).toBe(6);
    expect(budget.tasks).toBe(2);
    // 25 rows is the nearest height whose usable rows divide evenly, so
    // assert the ratio itself there rather than on a remainder.
    const even = computeSidebarRowBudget(25);
    expect(even.sessions).toBe(6);
    expect(even.tasks).toBe(3);
    expect(even.sessions).toBe(even.tasks * 2);
    const tall = computeSidebarRowBudget(40);
    expect(tall.sessions).toBe(10);
    expect(tall.tasks).toBe(5);
  });

  it("keeps both panes alive at every height the rail is drawn at", () => {
    for (let rows = SIDEBAR_MIN_ROWS; rows <= 12; rows += 1) {
      const budget = computeSidebarRowBudget(rows);
      expect(budget.sessions).toBeGreaterThanOrEqual(1);
      expect(budget.tasks).toBeGreaterThanOrEqual(1);
    }
  });

  it("never budgets more rows than the window has", () => {
    // The rail renders `sessions + tasks + SIDEBAR_CHROME_ROWS` rows,
    // under a status bar that takes one more. Ink 7 overlaps rather
    // than clips, so overshooting here is what garbles the frame.
    for (let rows = 0; rows <= 60; rows += 1) {
      if (!isSidebarVisible(SIDEBAR_MIN_COLUMNS, rows)) continue;
      const budget = computeSidebarRowBudget(rows);
      expect(
        budget.sessions + budget.tasks + SIDEBAR_CHROME_ROWS + 1,
      ).toBeLessThanOrEqual(rows);
    }
  });

  it("stops growing once the caps are reached", () => {
    expect(computeSidebarRowBudget(200)).toEqual({ sessions: 10, tasks: 5 });
  });
});

describe("computeChatViewportRows", () => {
  it("reserves the prompt chrome but never returns less than five rows", () => {
    expect(computeChatViewportRows(40)).toBe(28);
    expect(computeChatViewportRows(10)).toBe(4);
    expect(computeChatViewportRows(2)).toBe(4);
  });

  it("reserves more chrome on a narrow terminal, where it wraps", () => {
    expect(computeChatViewportRows(24, 45)).toBe(8);
    expect(computeChatViewportRows(24, 80)).toBe(12);
  });
});
