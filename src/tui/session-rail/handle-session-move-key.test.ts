import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey } from "../app-key-bindings.js";
import {
  createInitialTuiState,
  type SessionPickerEntry,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";

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

function entry(sessionId: string): SessionPickerEntry {
  return {
    sessionId,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 0,
    preview: sessionId,
  };
}

/** Rail focused on Sessions with three rows and the cursor on `cursor`. */
function railState(cursor: number, section: "sessions" | "tasks" = "sessions"): TuiState {
  return {
    ...createInitialTuiState(session()),
    chatFocus: "sidebar",
    sidebarSection: section,
    sidebarCursor: cursor,
    recentSessions: [entry("s-1"), entry("s-2"), entry("s-3")],
  };
}

function ctx(state: TuiState) {
  return {
    state,
    dispatch: vi.fn(),
    callbacks: {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onSessionMoveRequested: vi.fn(),
      onSessionSwitchRequested: vi.fn(),
    },
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: true,
  };
}

describe("rail session move keys", () => {
  it("Shift+↑ moves the selected row up and takes the cursor with it", () => {
    const c = ctx(railState(1));
    expect(handleAppKey("", key({ upArrow: true, shift: true }), c)).toBe(true);
    expect(c.callbacks.onSessionMoveRequested).toHaveBeenCalledWith("s-2", 0);
    expect(c.dispatch).toHaveBeenCalledWith({ type: "sidebar_cursor_set", row: 0 });
    // Not a plain cursor move: the chord must not ALSO walk the list.
    expect(c.dispatch).not.toHaveBeenCalledWith({
      type: "sidebar_cursor_moved",
      delta: -1,
    });
  });

  it("Shift+↓ moves the selected row down", () => {
    const c = ctx(railState(1));
    expect(handleAppKey("", key({ downArrow: true, shift: true }), c)).toBe(true);
    expect(c.callbacks.onSessionMoveRequested).toHaveBeenCalledWith("s-2", 2);
    expect(c.dispatch).toHaveBeenCalledWith({ type: "sidebar_cursor_set", row: 2 });
  });

  it("accepts Meta+↑/↓ as the same chord", () => {
    const c = ctx(railState(2));
    expect(handleAppKey("", key({ upArrow: true, meta: true }), c)).toBe(true);
    expect(c.callbacks.onSessionMoveRequested).toHaveBeenCalledWith("s-3", 1);
  });

  it("does nothing on the top row for Shift+↑, and on the last for Shift+↓", () => {
    const top = ctx(railState(0));
    expect(handleAppKey("", key({ upArrow: true, shift: true }), top)).toBe(true);
    expect(top.callbacks.onSessionMoveRequested).not.toHaveBeenCalled();
    expect(top.dispatch).not.toHaveBeenCalled();
    const bottom = ctx(railState(2));
    expect(handleAppKey("", key({ downArrow: true, shift: true }), bottom)).toBe(true);
    expect(bottom.callbacks.onSessionMoveRequested).not.toHaveBeenCalled();
    expect(bottom.dispatch).not.toHaveBeenCalled();
  });

  it("leaves a plain ↑ alone", () => {
    const c = ctx(railState(1));
    expect(handleAppKey("", key({ upArrow: true }), c)).toBe(true);
    expect(c.callbacks.onSessionMoveRequested).not.toHaveBeenCalled();
    expect(c.dispatch).toHaveBeenCalledWith({ type: "sidebar_cursor_moved", delta: -1 });
  });

  it("is not a move on the Tasks pane", () => {
    const c = ctx(railState(1, "tasks"));
    handleAppKey("", key({ upArrow: true, shift: true }), c);
    expect(c.callbacks.onSessionMoveRequested).not.toHaveBeenCalled();
  });

  it("still swallows letters while the rail has focus", () => {
    const c = ctx(railState(1));
    expect(handleAppKey("q", key(), c)).toBe(true);
    expect(c.callbacks.onSessionMoveRequested).not.toHaveBeenCalled();
    expect(c.dispatch).not.toHaveBeenCalled();
  });
});
