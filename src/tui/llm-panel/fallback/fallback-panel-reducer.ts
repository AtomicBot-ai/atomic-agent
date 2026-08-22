import type { TuiAction } from "../../tui-action.js";
import type { TuiState } from "../../tui-state.js";
import { isFallbackPanelAction } from "./fallback-panel-actions.js";
import { clampFallbackCursor } from "./fallback-rows.js";

/**
 * Reducer for the Fallback pane. Handles the mirror-refresh from the
 * orchestrator (`fallback_refresh`), the add-link picker's pure UI
 * transitions, the status line and the last-switch capture. The
 * side-effectful edits (move/add/remove/toggle appendLocal) are not
 * reducer actions at all — they travel as `TuiAppCallbacks.onFallback*`
 * callbacks into `FallbackOrchestrator`, whose config write comes back
 * here as a `fallback_refresh` (see `fallback-panel-actions.ts`).
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
      const next = {
        ...state,
        fallbackPanel: {
          ...panel,
          links: action.links,
          addableProviderIds: action.addableProviderIds,
          appendLocal: action.appendLocal,
          addPicker,
        },
      };
      // A refresh can shrink the row list (a removed link, the add row
      // disappearing); re-clamp the pane cursor against the NEW rows so
      // it can never point past the end at nothing.
      return {
        ...next,
        llmPanel: {
          ...next.llmPanel,
          fallbackCursor: clampFallbackCursor(
            next,
            next.llmPanel.fallbackCursor,
          ),
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
    // No intent cases here on purpose: the edits are callbacks into
    // `FallbackOrchestrator` (`TuiAppCallbacks.onFallback*`), never
    // dispatched actions — a dispatched intent would dead-end in this
    // reducer without ever reaching the orchestrator's bus.
    default:
      return state;
  }
}
