import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";
import { handlePrivacyTabKey } from "./privacy-key-bindings.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 1,
  maxSteps: 10,
  skillCount: 0,
};

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

function privacyState(level: 1 | 2 | 3 | 4 | 5, busy = false): TuiState {
  const state = createInitialTuiState(SESSION);
  return {
    ...state,
    uiMode: "debug",
    activeTab: "privacy",
    privacyPanel: { ...state.privacyPanel, approvalLevel: level, busy },
  };
}

function ctx(state: TuiState, callbacks: Partial<TuiAppCallbacks>) {
  return {
    state,
    dispatch: vi.fn(),
    callbacks: callbacks as TuiAppCallbacks,
  };
}

describe("handlePrivacyTabKey", () => {
  it("digits 1..5 jump the ladder to that level", () => {
    const onApprovalLevelSetRequested = vi.fn();
    const context = ctx(privacyState(1), { onApprovalLevelSetRequested });
    for (const digit of ["1", "2", "3", "4", "5"]) {
      expect(handlePrivacyTabKey(digit, emptyKey(), context)).toBe(true);
    }
    expect(onApprovalLevelSetRequested.mock.calls.map((c) => c[0])).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("arrow keys step one level and clamp at the edges", () => {
    const onApprovalLevelSetRequested = vi.fn();
    const mid = ctx(privacyState(3), { onApprovalLevelSetRequested });
    expect(
      handlePrivacyTabKey("", emptyKey({ rightArrow: true }), mid),
    ).toBe(true);
    expect(onApprovalLevelSetRequested).toHaveBeenLastCalledWith(4);
    expect(
      handlePrivacyTabKey("", emptyKey({ leftArrow: true }), mid),
    ).toBe(true);
    expect(onApprovalLevelSetRequested).toHaveBeenLastCalledWith(2);

    // At the edges the key is consumed but no redundant request fires.
    onApprovalLevelSetRequested.mockClear();
    const top = ctx(privacyState(5), { onApprovalLevelSetRequested });
    expect(
      handlePrivacyTabKey("", emptyKey({ rightArrow: true }), top),
    ).toBe(true);
    const bottom = ctx(privacyState(1), { onApprovalLevelSetRequested });
    expect(
      handlePrivacyTabKey("", emptyKey({ leftArrow: true }), bottom),
    ).toBe(true);
    expect(onApprovalLevelSetRequested).not.toHaveBeenCalled();
  });

  it("keeps the analytics and refresh keys", () => {
    const onAnalyticsToggleRequested = vi.fn();
    const onPrivacyRefreshRequested = vi.fn();
    const context = ctx(privacyState(2), {
      onAnalyticsToggleRequested,
      onPrivacyRefreshRequested,
    });
    expect(handlePrivacyTabKey("a", emptyKey(), context)).toBe(true);
    expect(onAnalyticsToggleRequested).toHaveBeenCalledTimes(1);
    expect(handlePrivacyTabKey("r", emptyKey(), context)).toBe(true);
    expect(onPrivacyRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("swallows keys while busy and ignores other tabs", () => {
    const onApprovalLevelSetRequested = vi.fn();
    const busy = ctx(privacyState(1, true), { onApprovalLevelSetRequested });
    expect(handlePrivacyTabKey("3", emptyKey(), busy)).toBe(true);
    expect(onApprovalLevelSetRequested).not.toHaveBeenCalled();

    const otherTab = ctx(
      { ...privacyState(1), activeTab: "feed" },
      { onApprovalLevelSetRequested },
    );
    expect(handlePrivacyTabKey("3", emptyKey(), otherTab)).toBe(false);
  });
});
