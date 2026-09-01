import type { TuiState } from "../tui-state.js";
import { isPrivacyAction, type PrivacyAction } from "./privacy-actions.js";
import type { PrivacyPanelState } from "./privacy-panel-state.js";

/**
 * Reducer slice for `state.privacyPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through to other slices. Pure: every side effect
 * (config persistence, runtime hot-reload) lives in
 * `privacy-orchestrator.ts`.
 */
export function reducePrivacyAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isPrivacyAction(action)) return null;
  const panel = state.privacyPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, privacyPanel: next };
}

function reducePanel(
  panel: PrivacyPanelState,
  action: PrivacyAction,
): PrivacyPanelState {
  switch (action.type) {
    case "privacy_synced":
      return {
        ...panel,
        analyticsEnabled: action.analyticsEnabled,
        sessionGrants: action.sessionGrants,
      };
    case "privacy_action_started":
      return { ...panel, busy: true };
    case "privacy_action_settled":
      return {
        ...panel,
        busy: false,
        message: action.message ?? panel.message,
        lastError: action.error ?? panel.lastError,
      };
    case "privacy_message_cleared":
      return { ...panel, message: null, lastError: null };
    default:
      return panel;
  }
}
