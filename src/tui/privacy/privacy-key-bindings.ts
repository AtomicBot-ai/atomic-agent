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
 *  - `o` — toggle offline mode, only when the agent has the kill switch.
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
  if (input === "o") {
    if (!state.privacyPanel.offline.supported) return true;
    void callbacks.onOfflineToggleRequested?.();
    return true;
  }
  if (input === "r") {
    callbacks.onPrivacyRefreshRequested?.();
    return true;
  }
  return false;
}
