import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import {
  normaliseNextStepSuggestion,
  reduceTuiState,
  type TuiAction,
} from "./agent-event-reducer.js";
import {
  canAcceptNextStepSuggestion,
  handleAppKey,
} from "./app-key-bindings.js";
import { ghostSuggestionPlaceholder } from "./components/composer-overlay.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

function session(): TuiSessionInfo {
  return {
    sessionId: "s-1",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalLevel: 5,
    maxSteps: 8,
    skillCount: 0,
  };
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  } as Key;
}

function apply(state: TuiState, actions: TuiAction[]): TuiState {
  return actions.reduce(reduceTuiState, state);
}

const suggest = (text: string, sessionId = "s-1"): TuiAction => ({
  type: "agent_event",
  sessionId,
  event: { type: "next_step_suggestion", text },
});

function withSuggestion(text = "Run the tests"): TuiState {
  return apply(createInitialTuiState(session()), [suggest(text)]);
}

function pressTab(state: TuiState, opts: { shift?: boolean } = {}) {
  const dispatch = vi.fn();
  const handled = handleAppKey("\t", key({ tab: true, shift: opts.shift ?? false }), {
    state,
    dispatch,
    callbacks: {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
    },
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: true,
  });
  return { handled, dispatch };
}

describe("next-step suggestion state (ATO-1095)", () => {
  it("stores the suggestion from the agent event as one line", () => {
    const state = withSuggestion("  Run the\n  tests  ");
    expect(state.nextStepSuggestion).toBe("Run the tests");
  });

  it("drops a blank suggestion", () => {
    const state = apply(withSuggestion(), [suggest("   \n ")]);
    expect(state.nextStepSuggestion).toBeNull();
    expect(normaliseNextStepSuggestion("")).toBeNull();
  });

  it("ignores a suggestion from a session that is not on screen", () => {
    const state = apply(createInitialTuiState(session()), [
      suggest("Run the tests", "s-other"),
    ]);
    expect(state.nextStepSuggestion).toBeNull();
  });

  it("is cleared by typing", () => {
    const state = apply(withSuggestion(), [
      { type: "input_changed", value: "h" },
    ]);
    expect(state.nextStepSuggestion).toBeNull();
  });

  it("is cleared when a new turn starts", () => {
    const viaEvent = apply(withSuggestion(), [
      { type: "agent_event", sessionId: "s-1", event: { type: "turn_started", turnIndex: 1 } },
    ]);
    expect(viaEvent.nextStepSuggestion).toBeNull();
    const viaSubmit = apply(withSuggestion(), [
      { type: "message_submitted" },
    ]);
    expect(viaSubmit.nextStepSuggestion).toBeNull();
  });

  it("is cleared by a fresh session", () => {
    const state = apply(withSuggestion(), [
      { type: "session_created", sessionId: "s-2" },
    ]);
    expect(state.nextStepSuggestion).toBeNull();
  });

  it("accepting fills the empty composer and retires the suggestion", () => {
    const state = apply(withSuggestion("Run the tests"), [
      { type: "next_step_suggestion_accepted" },
    ]);
    expect(state.inputValue).toBe("Run the tests");
    expect(state.nextStepSuggestion).toBeNull();
  });

  it("accepting never overwrites a draft", () => {
    const base = withSuggestion("Run the tests");
    const drafted = { ...base, inputValue: "my draft" };
    const state = reduceTuiState(drafted, { type: "next_step_suggestion_accepted" });
    expect(state).toBe(drafted);
  });
});

describe("Tab on the composer (ATO-1095)", () => {
  it("takes the suggestion instead of moving focus to the rail", () => {
    const { handled, dispatch } = pressTab(withSuggestion());
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "next_step_suggestion_accepted" });
  });

  it("keeps its old meaning when there is no suggestion", () => {
    const { dispatch } = pressTab(createInitialTuiState(session()));
    expect(dispatch).toHaveBeenCalledWith({ type: "chat_focus_set", focus: "sidebar" });
  });

  it("keeps its old meaning when the composer holds text", () => {
    const state = { ...withSuggestion(), inputValue: "draft" };
    expect(canAcceptNextStepSuggestion(state)).toBe(false);
    const { dispatch } = pressTab(state);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "next_step_suggestion_accepted" });
  });

  it("leaves Tab to the slash palette while it is open", () => {
    const state = { ...withSuggestion(), slashPaletteOpen: true };
    expect(canAcceptNextStepSuggestion(state)).toBe(false);
    const { dispatch } = pressTab(state);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "next_step_suggestion_accepted" });
  });

  it("does not take the suggestion on Shift+Tab or with the rail focused", () => {
    expect(
      pressTab(withSuggestion(), { shift: true }).dispatch,
    ).not.toHaveBeenCalledWith({ type: "next_step_suggestion_accepted" });
    const railFocused: TuiState = { ...withSuggestion(), chatFocus: "sidebar" };
    expect(canAcceptNextStepSuggestion(railFocused)).toBe(false);
  });

  it("stands down while a plan is on offer", () => {
    const state = { ...withSuggestion(), planHandoff: true };
    expect(canAcceptNextStepSuggestion(state)).toBe(false);
  });
});

describe("ghostSuggestionPlaceholder", () => {
  it("names the key that takes the suggestion", () => {
    expect(ghostSuggestionPlaceholder("Run the tests")).toBe("Run the tests  · Tab");
  });

  it("cuts a long suggestion to one row", () => {
    const shown = ghostSuggestionPlaceholder("word ".repeat(60));
    expect(shown.length).toBeLessThanOrEqual(96 + "  · Tab".length);
    expect(shown).toContain("…");
  });
});
