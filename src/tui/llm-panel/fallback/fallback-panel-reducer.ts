import type { TuiAction } from "../../tui-action.js";
import type { TuiState } from "../../tui-state.js";
import { isFallbackPanelAction } from "./fallback-panel-actions.js";

/**
 * Reducer for the Fallback pane. Handles the mirror-refresh from the
 * orchestrator (`fallback_refresh`), the add-link picker's pure UI
 * transitions, the status line and the last-switch capture. The
 * side-effectful intents (`fallback_move_requested`,
 * `fallback_add_requested`, `fallback_remove_requested`,
 * `fallback_append_local_toggle_requested`) are handled by
 * `FallbackOrchestrator` off the event bus — they only reach the reducer
 * as a follow-up `fallback_refresh`, so this reducer treats them as
 * no-ops (returns state unchanged) to keep the pane responsive.
 */
export function reduceFallbackPanelAction(
  state: TuiState,
  action: TuiAction,
): TuiState | null {
  if (!isFallbackPanelAction(action)) return null;
  const panel = state.fallbackPanel;
  switch (action.type) {
    case "fallback_refresh": {
      // Clamp the picker cursor to the new addable list; close it when
      // nothing is addable anymore.
      const addPicker =
        panel.addPicker && action.addableProviderIds.length > 0
          ? {
              cursor: Math.min(
                panel.addPicker.cursor,
                action.addableProviderIds.length - 1,
              ),
            }
          : null;
      return {
        ...state,
        fallbackPanel: {
          ...panel,
          links: action.links,
          addableProviderIds: action.addableProviderIds,
          appendLocal: action.appendLocal,
          addPicker,
        },
      };
    }
    case "fallback_add_picker_opened":
      if (panel.addableProviderIds.length === 0) return state;
      return {
        ...state,
        fallbackPanel: { ...panel, addPicker: { cursor: 0 }, statusLine: null },
      };
    case "fallback_add_picker_closed":
      return {
        ...state,
        fallbackPanel: { ...panel, addPicker: null },
      };
    case "fallback_add_picker_cursor_set": {
      if (!panel.addPicker) return state;
      const last = Math.max(0, panel.addableProviderIds.length - 1);
      return {
        ...state,
        fallbackPanel: {
          ...panel,
          addPicker: { cursor: Math.min(last, Math.max(0, action.cursor)) },
        },
      };
    }
    case "fallback_status":
      return {
        ...state,
        fallbackPanel: { ...panel, statusLine: action.line },
      };
    case "fallback_last_switch_set":
      return {
        ...state,
        fallbackPanel: { ...panel, lastSwitch: action.lastSwitch },
      };
    // Side-effectful intents are consumed by the orchestrator; they land
    // back here only as a `fallback_refresh`.
    case "fallback_move_requested":
    case "fallback_add_requested":
    case "fallback_remove_requested":
    case "fallback_append_local_toggle_requested":
      return state;
    default:
      return state;
  }
}
