import type { Key } from "ink";
import { clampApprovalLevel } from "../../approval/approval-level.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";

export interface PrivacyTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Privacy tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed so the editor echo is suppressed.
 *
 *  - `1`..`5` — jump the approval ladder to that level.
 *  - `←` / `→` — step the approval ladder one level down / up.
 *  - `a` — toggle anonymous analytics + error reporting.
 *  - `r` — refresh the persisted snapshot.
 *
 * Digits and arrows are free on this tab: `handleAppKey` only claims
 * arrows in chat mode (scroll) and sidebar focus, and no debug-mode
 * surface binds digits globally.
 */
export function handlePrivacyTabKey(
  input: string,
  key: Key,
  ctx: PrivacyTabKeyContext,
): boolean {
  const { state, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "privacy") return false;
  if (state.privacyPanel.busy) return true;
  if (input >= "1" && input <= "5") {
    void callbacks.onApprovalLevelSetRequested?.(Number(input));
    return true;
  }
  if (key.leftArrow || key.rightArrow) {
    const target = clampApprovalLevel(
      state.privacyPanel.approvalLevel + (key.rightArrow ? 1 : -1),
    );
    if (target !== state.privacyPanel.approvalLevel) {
      void callbacks.onApprovalLevelSetRequested?.(target);
    }
    return true;
  }
  if (input === "a") {
    void callbacks.onAnalyticsToggleRequested?.();
    return true;
  }
  if (input === "r") {
    callbacks.onPrivacyRefreshRequested?.();
    return true;
  }
  return false;
}
