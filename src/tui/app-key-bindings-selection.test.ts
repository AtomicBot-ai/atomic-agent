import { describe, it, expect, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey } from "./app-key-bindings.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

/**
 * The Ctrl+C stand-down ladder around a composer selection.
 *
 * A live selection makes the *editor* own Ctrl+C (copy), so the global
 * layer must not arm the quit for the same press — but only while the
 * editor actually has the keyboard. The selection flag survives Tab
 * into the sidebar, an open menu, and an armed leader; in all of those
 * the editor's handler is inactive and a stand-down would leave Ctrl+C
 * claimed by nobody (no abort, no quit) until focus returned.
 */
function stubSession(): TuiSessionInfo {
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

function ctrlC(): Key {
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
    ctrl: true,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  } as Key;
}

function pressCtrlC(
  stateOverrides: Partial<TuiState>,
  options: { menuLeaderArmed?: boolean } = {},
) {
  const state: TuiState = {
    ...createInitialTuiState(stubSession()),
    uiMode: "chat" as const,
    composerHasSelection: true,
    inputValue: "hello",
    ...stateOverrides,
  };
  const setCtrlCArmed = vi.fn();
  const handled = handleAppKey("c", ctrlC(), {
    state,
    dispatch: vi.fn(),
    callbacks: {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
    },
    ctrlCArmed: false,
    setCtrlCArmed,
    sidebarVisible: true,
    menuLeaderArmed: options.menuLeaderArmed ?? false,
    setMenuLeaderArmed: vi.fn(),
    activateMenuNode: vi.fn(),
  });
  return { handled, setCtrlCArmed };
}

describe("Ctrl+C vs composer selection", () => {
  it("stands down while the focused editor holds a selection", () => {
    const run = pressCtrlC({ chatFocus: "editor" });
    expect(run.handled).toBe(false);
    expect(run.setCtrlCArmed).not.toHaveBeenCalledWith(true);
  });

  it("still arms the quit when focus is on the sidebar", () => {
    const run = pressCtrlC({ chatFocus: "sidebar" });
    expect(run.handled).toBe(true);
    expect(run.setCtrlCArmed).toHaveBeenCalledWith(true);
  });

  it("is still claimed (by the menu layer) while the menu is open", () => {
    // The menu sits above the Ctrl+C branch in the ladder and takes the
    // key itself. What matters here is that a stale selection does not
    // make anyone stand down into a dead key: the press is handled.
    const run = pressCtrlC({ chatFocus: "editor", menuOpen: true });
    expect(run.handled).toBe(true);
  });

  it("still aborts through an armed leader", () => {
    // A modified key falls through the armed-leader branch by design;
    // the selection must not turn that fall-through into a dead key.
    const run = pressCtrlC({ chatFocus: "editor" }, { menuLeaderArmed: true });
    expect(run.handled).toBe(true);
    expect(run.setCtrlCArmed).toHaveBeenCalledWith(true);
  });
});
