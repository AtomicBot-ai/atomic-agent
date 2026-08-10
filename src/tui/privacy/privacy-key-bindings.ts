import type { Key } from "ink";
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
 *  - `a` — toggle anonymous analytics + error reporting.
 *  - `y` — toggle approve everything (agent runs without asking).
 *  - `r` — refresh the persisted snapshot.
 */
export function handlePrivacyTabKey(
  input: string,
  _key: Key,
  ctx: PrivacyTabKeyContext,
): boolean {
  const { state, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "privacy") return false;
  if (state.privacyPanel.busy) return true;
  if (input === "a") {
    void callbacks.onAnalyticsToggleRequested?.();
    return true;
  }
  if (input === "y") {
    void callbacks.onApproveEverythingToggleRequested?.();
    return true;
  }
  if (input === "r") {
    callbacks.onPrivacyRefreshRequested?.();
    return true;
  }
  return false;
}
