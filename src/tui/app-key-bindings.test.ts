import { describe, it, expect, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey } from "./app-key-bindings.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
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

function stubSession(): TuiSessionInfo {
  return {
    sessionId: "s-x",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalRequired: false,
    maxSteps: 8,
    skillCount: 0,
  };
}

describe("handleAppKey", () => {
  it("returns false when no binding matches", () => {
    const state = createInitialTuiState(stubSession());
    const handled = handleAppKey("z", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
    });
    expect(handled).toBe(false);
  });
});
