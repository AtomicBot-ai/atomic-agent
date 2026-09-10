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

function entry(sessionId: string, pinned = false): SessionPickerEntry {
  return {
    sessionId,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 0,
    preview: sessionId,
    pinned,
  };
}

function railState(
  cursor: number,
  section: "sessions" | "tasks" = "sessions",
  rows: SessionPickerEntry[] = [entry("s-1"), entry("s-2", true)],
): TuiState {
  return {
    ...createInitialTuiState(session()),
    chatFocus: "sidebar",
    sidebarSection: section,
    sidebarCursor: cursor,
    recentSessions: rows,
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
      onSessionPinToggled: vi.fn(),
      onSessionSwitchRequested: vi.fn(),
      onSessionMoveRequested: vi.fn(),
    },
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: true,
  };
}

describe("rail session pin key", () => {
  it("`p` toggles the pin of the selected row", () => {
    const c = ctx(railState(0));
    expect(handleAppKey("p", key(), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).toHaveBeenCalledWith("s-1");
  });

  it("takes the cursor to the row's new slot so a second `p` undoes the first", () => {
    // s-2 is pinned, so the block is one row long and an unpinned s-1
    // pinned now lands right after it, at index 1.
    const rows = [entry("s-2", true), entry("s-1")];
    const c = ctx(railState(1, "sessions", rows));
    expect(handleAppKey("p", key(), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).toHaveBeenCalledWith("s-1");
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "sidebar_cursor_set",
      row: 1,
    });
  });

  it("follows a released row to the head of the unpinned half", () => {
    // Two pinned rows; releasing the first leaves a one-row block, so
    // the row it is released to is index 1.
    const rows = [entry("s-1", true), entry("s-2", true), entry("s-3")];
    const c = ctx(railState(0, "sessions", rows));
    expect(handleAppKey("p", key(), c)).toBe(true);
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "sidebar_cursor_set",
      row: 1,
    });
  });

  it("works on an already-pinned row — the same key releases it", () => {
    const c = ctx(railState(1));
    expect(handleAppKey("p", key(), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).toHaveBeenCalledWith("s-2");
  });

  it("accepts an upper-case P", () => {
    const c = ctx(railState(0));
    expect(handleAppKey("P", key({ shift: true }), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).toHaveBeenCalledWith("s-1");
  });

  it("leaves the Tasks pane alone", () => {
    const c = ctx(railState(0, "tasks"));
    // Still consumed — the rail swallows letters so they cannot reach
    // the composer — but no pin is toggled.
    expect(handleAppKey("p", key(), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).not.toHaveBeenCalled();
  });

  it("does not fire on ctrl+p or meta+p", () => {
    const withCtrl = ctx(railState(0));
    handleAppKey("p", key({ ctrl: true }), withCtrl);
    expect(withCtrl.callbacks.onSessionPinToggled).not.toHaveBeenCalled();
    const withMeta = ctx(railState(0));
    handleAppKey("p", key({ meta: true }), withMeta);
    expect(withMeta.callbacks.onSessionPinToggled).not.toHaveBeenCalled();
  });

  it("still swallows other letters instead of pinning", () => {
    const c = ctx(railState(0));
    expect(handleAppKey("q", key(), c)).toBe(true);
    expect(c.callbacks.onSessionPinToggled).not.toHaveBeenCalled();
  });
});
