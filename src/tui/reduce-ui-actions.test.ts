import { describe, expect, it } from "vitest";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { THEME_NAMES } from "./theme/theme.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:19091",
  browserChannel: "chromium",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

describe("reduceUiAction theme_set", () => {
  it("stores the new theme name to trigger a re-render", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceUiAction(state, { type: "theme_set", name: "dracula" });
    expect(next).not.toBeNull();
    expect(next?.themeName).toBe("dracula");
  });

  it("leaves other slices untouched", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceUiAction(state, { type: "theme_set", name: "nord" });
    expect(next?.uiMode).toBe(state.uiMode);
    expect(next?.activeTab).toBe(state.activeTab);
  });
});

describe("reduceUiAction theme picker", () => {
  it("opens the picker seeded from the active theme name + records original", () => {
    const base = createInitialTuiState(SESSION);
    const seeded = { ...base, themeName: "nord" };
    const next = reduceUiAction(seeded, { type: "theme_picker_opened" });
    expect(next?.themePickerOpen).toBe(true);
    expect(next?.themePickerOriginal).toBe("nord");
    expect(next?.themePickerCursor).toBe(
      (THEME_NAMES as readonly string[]).indexOf("nord"),
    );
  });

  it("falls back to cursor 0 when the active theme is unknown", () => {
    const base = createInitialTuiState(SESSION);
    const seeded = { ...base, themeName: "not-a-real-theme" };
    const next = reduceUiAction(seeded, { type: "theme_picker_opened" });
    expect(next?.themePickerCursor).toBe(0);
  });

  it("clamps cursor movement within [0, THEME_NAMES.length - 1]", () => {
    const base = createInitialTuiState(SESSION);
    const open = reduceUiAction(base, { type: "theme_picker_opened" })!;
    const atZero = { ...open, themePickerCursor: 0 };
    const stillZero = reduceUiAction(atZero, {
      type: "theme_picker_cursor_moved",
      delta: -1,
    });
    expect(stillZero?.themePickerCursor).toBe(0);

    const last = THEME_NAMES.length - 1;
    const atLast = { ...open, themePickerCursor: last };
    const stillLast = reduceUiAction(atLast, {
      type: "theme_picker_cursor_moved",
      delta: 1,
    });
    expect(stillLast?.themePickerCursor).toBe(last);
  });

  it("ignores cursor movement when the picker is closed", () => {
    const base = createInitialTuiState(SESSION);
    const next = reduceUiAction(base, {
      type: "theme_picker_cursor_moved",
      delta: 1,
    });
    expect(next?.themePickerCursor).toBe(base.themePickerCursor);
  });

  it("closes the picker and clears the original mark", () => {
    const base = createInitialTuiState(SESSION);
    const open = reduceUiAction(base, { type: "theme_picker_opened" })!;
    const closed = reduceUiAction(open, { type: "theme_picker_closed" });
    expect(closed?.themePickerOpen).toBe(false);
    expect(closed?.themePickerOriginal).toBe("");
  });
});
