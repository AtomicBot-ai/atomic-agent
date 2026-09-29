import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "./tui-state.js";
import type { SessionRecord } from "../session/session-types.js";
import type { TuiState } from "./tui-state.js";
import {
  selectExtraChromeRows,
  selectHintRows,
  selectRailVisible,
} from "./select-chrome-rows.js";
import {
  computeHintRowBudget,
  computeMainColumnWidth,
  isSidebarVisible,
} from "./layout.js";

function fakeSession(): SessionRecord {
  return {
    id: "sess-1",
    title: "Session",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  } as unknown as SessionRecord;
}

const chatState = (over: Partial<TuiState> = {}): TuiState => ({
  ...createInitialTuiState(fakeSession()),
  uiMode: "chat" as const,
  ...over,
});

/** The size measured under a PTY as "the common terminal". */
const COMMON = { columns: 120, rows: 40 };

describe("selectRailVisible", () => {
  it("agrees with the geometry gate on a chat screen", () => {
    expect(selectRailVisible(chatState(), COMMON)).toBe(
      isSidebarVisible(COMMON.columns, COMMON.rows),
    );
  });

  it("hides the rail on a panel and when the operator folded it away", () => {
    expect(selectRailVisible(chatState({ uiMode: "debug" }), COMMON)).toBe(
      false,
    );
    expect(
      selectRailVisible(chatState({ sidebarCollapsed: true }), COMMON),
    ).toBe(false);
  });
});

describe("selectHintRows", () => {
  /**
   * The number the whole change turns on: 120 columns leaves the chat
   * column 83, and at 83 the idle strip does not fit on one row. If this
   * ever comes back as 1 on a 40-row window, the budget stopped reaching
   * the strip.
   */
  it("wraps the idle strip at the common terminal size", () => {
    expect(selectHintRows(chatState(), COMMON)).toBeGreaterThan(1);
  });

  it("measures at the main column, not the terminal", () => {
    // Folding the rail away widens the strip, so it needs no more rows
    // than it did with the rail up — and usually fewer.
    const withRail = selectHintRows(chatState(), COMMON);
    const without = selectHintRows(
      chatState({ sidebarCollapsed: true }),
      COMMON,
    );
    expect(without).toBeLessThanOrEqual(withRail);
    expect(computeMainColumnWidth(COMMON.columns, false)).toBeGreaterThan(
      computeMainColumnWidth(COMMON.columns, true),
    );
  });

  it("never exceeds the budget the window granted", () => {
    for (const rows of [16, 20, 24, 30, 40, 60]) {
      for (const columns of [40, 60, 80, 100, 120, 170, 200]) {
        const size = { columns, rows };
        expect(selectHintRows(chatState(), size)).toBeLessThanOrEqual(
          computeHintRowBudget(rows),
        );
        expect(selectHintRows(chatState(), size)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("holds a short window to the single row it always had", () => {
    expect(selectHintRows(chatState(), { columns: 60, rows: 20 })).toBe(1);
  });

  it("answers one row rather than dividing by a zero-width column", () => {
    expect(selectHintRows(chatState(), { columns: 0, rows: 40 })).toBe(1);
  });
});

describe("selectExtraChromeRows", () => {
  it("is the surplus over the one-row baseline", () => {
    expect(selectExtraChromeRows(chatState(), COMMON)).toBe(
      selectHintRows(chatState(), COMMON) - 1,
    );
  });

  it("is zero when nothing wraps", () => {
    expect(selectExtraChromeRows(chatState(), { columns: 240, rows: 40 })).toBe(
      0,
    );
  });
});
