import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey } from "./app-key-bindings.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

/**
 * Keys for the "delete the session?" dialog. The load-bearing rule is
 * the default: the cursor starts on Cancel, so Enter from a reflex is a
 * dismissal rather than a deleted thread.
 */
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
    sessionId: "s-x",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalLevel: 5,
    maxSteps: 8,
    skillCount: 0,
  };
}

function confirming(cursor: "yes" | "cancel" = "cancel"): TuiState {
  return {
    ...createInitialTuiState(session()),
    sessionDelete: { sessionId: "s-doomed", preview: "old thread", cursor },
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
      onSessionDeleteConfirmed: vi.fn(),
    },
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: true,
  };
}

describe("session delete confirmation keys", () => {
  it("deletes on y", () => {
    const c = ctx(confirming());
    expect(handleAppKey("y", key(), c)).toBe(true);
    expect(c.callbacks.onSessionDeleteConfirmed).toHaveBeenCalledWith("s-doomed");
    expect(c.dispatch).toHaveBeenCalledWith({ type: "session_delete_closed" });
  });

  it("cancels on n and on Esc, without deleting", () => {
    for (const stroke of [
      { input: "n", k: key() },
      { input: "", k: key({ escape: true }) },
    ]) {
      const c = ctx(confirming());
      expect(handleAppKey(stroke.input, stroke.k, c)).toBe(true);
      expect(c.callbacks.onSessionDeleteConfirmed).not.toHaveBeenCalled();
      expect(c.dispatch).toHaveBeenCalledWith({ type: "session_delete_closed" });
    }
  });

  it("Enter on the default cursor dismisses rather than deletes", () => {
    // The dialog opens on Cancel. Someone who hits Enter without reading
    // it must not lose a thread.
    const c = ctx(confirming("cancel"));
    expect(handleAppKey("", key({ return: true }), c)).toBe(true);
    expect(c.callbacks.onSessionDeleteConfirmed).not.toHaveBeenCalled();
    expect(c.dispatch).toHaveBeenCalledWith({ type: "session_delete_closed" });
  });

  it("Enter deletes once the cursor is moved to Yes", () => {
    const c = ctx(confirming("yes"));
    expect(handleAppKey("", key({ return: true }), c)).toBe(true);
    expect(c.callbacks.onSessionDeleteConfirmed).toHaveBeenCalledWith("s-doomed");
  });

  it("arrows and Tab move between the two controls", () => {
    const c = ctx(confirming("cancel"));
    expect(handleAppKey("", key({ leftArrow: true }), c)).toBe(true);
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "session_delete_cursor_set",
      cursor: "yes",
    });
  });

  it("swallows every other key so nothing reaches the rail behind it", () => {
    const c = ctx(confirming());
    expect(handleAppKey("q", key(), c)).toBe(true);
    expect(c.callbacks.onQuit).not.toHaveBeenCalled();
    expect(c.callbacks.onSessionDeleteConfirmed).not.toHaveBeenCalled();
  });
});
