import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
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

describe("input history navigation", () => {
  const withHistory = (draft: string) => ({
    ...createInitialTuiState(SESSION),
    inputHistory: ["first", "second"],
    inputValue: draft,
  });

  it("preserves the in-progress draft when Up recalls history", () => {
    const state = withHistory("draft I am typing");
    const up = reduceTuiState(state, { type: "input_history_navigated", delta: -1 });
    expect(up.inputValue).toBe("second");
    const back = reduceTuiState(up, { type: "input_history_navigated", delta: 1 });
    expect(back.inputValue).toBe("draft I am typing");
  });

  it("keeps the history cursor when the caret moves without editing", () => {
    const state = withHistory("draft");
    const up = reduceTuiState(state, { type: "input_history_navigated", delta: -1 });
    expect(up.inputHistoryCursor).toBe(1);
    const caret = reduceTuiState(up, { type: "input_changed", value: "second" });
    expect(caret.inputHistoryCursor).toBe(1);
    const older = reduceTuiState(caret, { type: "input_history_navigated", delta: -1 });
    expect(older.inputValue).toBe("first");
  });

  it("drops the stashed draft once the recalled entry is edited", () => {
    const state = withHistory("draft");
    const up = reduceTuiState(state, { type: "input_history_navigated", delta: -1 });
    const edited = reduceTuiState(up, { type: "input_changed", value: "second!" });
    expect(edited.inputHistoryCursor).toBeNull();
    const down = reduceTuiState(edited, { type: "input_history_navigated", delta: 1 });
    expect(down.inputValue).toBe("second!");
  });
});
