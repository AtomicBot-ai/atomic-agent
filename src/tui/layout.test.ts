import { describe, expect, it } from "vitest";
import {
  computeChatViewportRows,
  computeChatWidth,
  computeHintRowBudget,
  computeMainColumnWidth,
  computeSidebarRowBudget,
  computeSidebarWidth,
  isSidebarVisible,
  SIDEBAR_CHROME_ROWS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_MIN_ROWS,
  SIDEBAR_MIN_WIDTH,
  HINT_ROW_MIN_ROWS,
  MAX_HINT_EXTRA_ROWS,
  RAIL_GUTTER_COLUMNS,
  ROOT_PADDING_LEFT,
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

  /**
   * The rows the composer's adaptive chrome spends over its one-row
   * baseline come out of the transcript. A viewport that kept them would
   * scroll lines the composer is standing on.
   */
  it("hands over the rows the composer's chrome is spending", () => {
    expect(computeChatViewportRows(40, 200, 0)).toBe(
      computeChatViewportRows(40, 200),
    );
    expect(computeChatViewportRows(40, 200, 2)).toBe(
      computeChatViewportRows(40, 200) - 2,
    );
  });

  it("holds the floor however many rows the chrome asks for", () => {
    expect(computeChatViewportRows(20, 200, 40)).toBe(4);
  });

  it("ignores a negative surplus rather than growing the viewport", () => {
    expect(computeChatViewportRows(40, 200, -5)).toBe(
      computeChatViewportRows(40, 200),
    );
  });
});

/**
 * The hint strip buys its extra rows from the window's height: a window
 * at the floor gets the single-row strip this app shipped with, and a
 * tall one can afford to let the strip say everything.
 */
describe("computeHintRowBudget", () => {
  it("gives a short window exactly the one row it always had", () => {
    expect(computeHintRowBudget(HINT_ROW_MIN_ROWS - 1)).toBe(1);
    expect(computeHintRowBudget(24)).toBe(1);
    expect(computeHintRowBudget(0)).toBe(1);
  });

  /**
   * 24 rows is the case that has to stay untouched: the overlay growth
   * suite mounts at ink-testing-library's 100x24 and asserts a ten-line
   * draft expands the composer by nine rows. A second strip row comes
   * straight out of `maxComposerEditorLines`, which fell to 9 and broke
   * it — this is that regression, pinned.
   */
  it("spends nothing on hints at the classic 24-row terminal", () => {
    expect(computeHintRowBudget(24)).toBe(1);
  });

  it("starts buying rows at the threshold the meta bar already measured", () => {
    expect(computeHintRowBudget(HINT_ROW_MIN_ROWS)).toBe(2);
  });

  it("never gives a row away twice, and never goes backwards", () => {
    let previous = 0;
    for (let rows = 0; rows <= 120; rows += 1) {
      const budget = computeHintRowBudget(rows);
      expect(budget).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });

  it("caps the strip however tall the window gets", () => {
    const cap = 1 + MAX_HINT_EXTRA_ROWS;
    expect(computeHintRowBudget(120)).toBe(cap);
    expect(computeHintRowBudget(400)).toBe(cap);
  });

  it("spends a row on hints only once the window can seat one", () => {
    // Every extra row is a row of transcript, so the budget must leave
    // the viewport its floor at every height it grants.
    for (let rows = 0; rows <= 200; rows += 1) {
      const extra = computeHintRowBudget(rows) - 1;
      expect(computeChatViewportRows(rows, 200, extra)).toBeGreaterThanOrEqual(
        4,
      );
    }
  });
});

/**
 * The width the strip is rendered at, which is the width its row count
 * has to be measured at. Distinct from `computeChatWidth` by exactly the
 * rail's gutter — the discrepancy that used to live between `layout.ts`
 * and `tui-app.tsx`'s own copy of the arithmetic.
 */
describe("computeMainColumnWidth", () => {
  it("takes only the root padding when the rail is away", () => {
    expect(computeMainColumnWidth(120, false)).toBe(120 - ROOT_PADDING_LEFT);
  });

  it("takes the rail and its gutter when the rail is up", () => {
    expect(computeMainColumnWidth(120, true)).toBe(
      120 - ROOT_PADDING_LEFT - computeSidebarWidth(120) - RAIL_GUTTER_COLUMNS,
    );
  });

  it("is the chat width less the gutter", () => {
    expect(computeMainColumnWidth(120, true)).toBe(
      computeChatWidth(120, TALL) - RAIL_GUTTER_COLUMNS,
    );
  });

  it("never goes negative on a terminal narrower than its own chrome", () => {
    expect(computeMainColumnWidth(1, true)).toBe(0);
    expect(computeMainColumnWidth(0, false)).toBe(0);
  });
});
