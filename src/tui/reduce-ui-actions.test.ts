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
  completionMaxTokens: 2048,
  skillCount: 0,
};

describe("reduceUiAction theme_set", () => {
  it("stores the new theme name to trigger a re-render", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceUiAction(state, { type: "theme_set", name: "khorne-red" });
    expect(next).not.toBeNull();
    expect(next?.themeName).toBe("khorne-red");
  });

  it("leaves other slices untouched", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceUiAction(state, { type: "theme_set", name: "darky-dark" });
    expect(next?.uiMode).toBe(state.uiMode);
    expect(next?.activeTab).toBe(state.activeTab);
  });
});

describe("reduceUiAction theme picker", () => {
  it("opens the picker seeded from the active theme name + records original", () => {
    const base = createInitialTuiState(SESSION);
    const seeded = { ...base, themeName: "darky-dark" };
    const next = reduceUiAction(seeded, { type: "theme_picker_opened" });
    expect(next?.themePickerOpen).toBe(true);
    expect(next?.themePickerOriginal).toBe("darky-dark");
    expect(next?.themePickerCursor).toBe(
      (THEME_NAMES as readonly string[]).indexOf("darky-dark"),
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

describe("reduceUiAction message_queued", () => {
  it("parks the message and clears the editor", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceUiAction(
      { ...state, inputValue: "draft" },
      { type: "message_queued", text: "draft" },
    );
    expect(next?.queuedMessages).toEqual(["draft"]);
    expect(next?.inputValue).toBe("");
  });

  it("appends in submission order", () => {
    const state = createInitialTuiState(SESSION);
    const first = reduceUiAction(state, { type: "message_queued", text: "a" });
    const second = reduceUiAction(first!, { type: "message_queued", text: "b" });
    expect(second?.queuedMessages).toEqual(["a", "b"]);
  });

  it("leaves the running turn's state alone", () => {
    // The whole point of a separate action: `message_submitted` calls
    // startNewRun, which would blank the feed of the turn in flight.
    const state = {
      ...createInitialTuiState(SESSION),
      status: "running" as const,
      currentStep: 3,
      runStartedAt: 1234,
    };
    const next = reduceUiAction(state, { type: "message_queued", text: "x" });
    expect(next?.status).toBe("running");
    expect(next?.currentStep).toBe(3);
    expect(next?.runStartedAt).toBe(1234);
  });

  it("mirrors the orchestrator queue on queue_changed", () => {
    const state = createInitialTuiState(SESSION);
    const seeded = reduceUiAction(state, { type: "message_queued", text: "a" });
    const next = reduceUiAction(seeded!, {
      type: "queue_changed",
      queued: [],
    });
    expect(next?.queuedMessages).toEqual([]);
  });

  it("drops the queue when the session is switched", () => {
    const state = createInitialTuiState(SESSION);
    const seeded = reduceUiAction(state, { type: "message_queued", text: "a" });
    const next = reduceUiAction(seeded!, {
      type: "session_switched",
      sessionId: "s2",
      workingDir: "/tmp",
      messages: [],
    });
    expect(next?.queuedMessages).toEqual([]);
  });
});

describe("reduceUiAction while_busy_mode_changed", () => {
  it("toggles when no explicit mode is given", () => {
    const state = createInitialTuiState(SESSION);
    expect(state.whileBusyMode).toBe("steer");
    const toQueue = reduceUiAction(state, { type: "while_busy_mode_changed" });
    expect(toQueue?.whileBusyMode).toBe("queue");
    const backToSteer = reduceUiAction(toQueue!, {
      type: "while_busy_mode_changed",
    });
    expect(backToSteer?.whileBusyMode).toBe("steer");
  });

  it("sets an explicit mode idempotently", () => {
    const state = createInitialTuiState(SESSION);
    const once = reduceUiAction(state, {
      type: "while_busy_mode_changed",
      mode: "queue",
    });
    const twice = reduceUiAction(once!, {
      type: "while_busy_mode_changed",
      mode: "queue",
    });
    expect(twice?.whileBusyMode).toBe("queue");
  });

  it("message_steered clears the editor without parking the message", () => {
    const state = { ...createInitialTuiState(SESSION), inputValue: "draft" };
    const next = reduceUiAction(state, {
      type: "message_steered",
      text: "draft",
    });
    expect(next?.inputValue).toBe("");
    // The bubble arrives with `steer_applied`, so nothing is queued and
    // nothing is rendered yet — a steer that misses the turn must not
    // show up twice when it falls back to the queue.
    expect(next?.queuedMessages).toEqual([]);
    expect(next?.messages).toEqual([]);
  });
});


describe("the context panel", () => {
  const open = (): ReturnType<typeof reduceTuiState> =>
    reduceTuiState(createInitialTuiState(SESSION), {
      type: "context_panel_toggled",
    });

  it("toggles", () => {
    const opened = open();
    expect(opened.contextPanelOpen).toBe(true);
    expect(
      reduceTuiState(opened, { type: "context_panel_toggled" }).contextPanelOpen,
    ).toBe(false);
  });

  it("closes explicitly", () => {
    expect(
      reduceTuiState(open(), { type: "context_panel_closed" }).contextPanelOpen,
    ).toBe(false);
  });

  /**
   * Two absolutely-positioned panels in a terminal do not stack, they
   * interleave. Opening the menu takes the floor.
   */
  it("gives way to the menu", () => {
    const next = reduceTuiState(open(), { type: "menu_opened" });
    expect(next.menuOpen).toBe(true);
    expect(next.contextPanelOpen).toBe(false);
  });
});
