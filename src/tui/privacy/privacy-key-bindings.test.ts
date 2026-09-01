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

function privacyState(busy = false): TuiState {
  const state = createInitialTuiState(SESSION);
  return {
    ...state,
    uiMode: "debug",
    activeTab: "privacy",
    privacyPanel: { ...state.privacyPanel, busy },
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
  it("keeps the analytics and refresh keys", () => {
    const onAnalyticsToggleRequested = vi.fn();
    const onPrivacyRefreshRequested = vi.fn();
    const context = ctx(privacyState(), {
      onAnalyticsToggleRequested,
      onPrivacyRefreshRequested,
    });
    expect(handlePrivacyTabKey("a", emptyKey(), context)).toBe(true);
    expect(onAnalyticsToggleRequested).toHaveBeenCalledTimes(1);
    expect(handlePrivacyTabKey("r", emptyKey(), context)).toBe(true);
    expect(onPrivacyRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("no longer claims the old approval-ladder keys", () => {
    // Digits and arrows fall through: the approval stance lives in the
    // composer's coding-mode control now, not on this tab.
    const context = ctx(privacyState(), {});
    for (const digit of ["1", "2", "3", "4", "5"]) {
      expect(handlePrivacyTabKey(digit, emptyKey(), context)).toBe(false);
    }
    expect(
      handlePrivacyTabKey("", emptyKey({ leftArrow: true }), context),
    ).toBe(false);
    expect(
      handlePrivacyTabKey("", emptyKey({ rightArrow: true }), context),
    ).toBe(false);
  });

  it("swallows keys while busy and ignores other tabs", () => {
    const onAnalyticsToggleRequested = vi.fn();
    const busy = ctx(privacyState(true), { onAnalyticsToggleRequested });
    expect(handlePrivacyTabKey("a", emptyKey(), busy)).toBe(true);
    expect(onAnalyticsToggleRequested).not.toHaveBeenCalled();

    const otherTab = ctx(
      { ...privacyState(), activeTab: "feed" },
      { onAnalyticsToggleRequested },
    );
    expect(handlePrivacyTabKey("a", emptyKey(), otherTab)).toBe(false);
  });
});
