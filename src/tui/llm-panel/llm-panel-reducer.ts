import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isLlmPanelAction } from "./llm-panel-actions.js";
import type { LlmPanelMode } from "./llm-panel-state.js";

export function reduceLlmPanelAction(
  state: TuiState,
  action: TuiAction,
): TuiState | null {
  if (!isLlmPanelAction(action)) return null;
  const panel = state.llmPanel;
  switch (action.type) {
    case "llm_mode_set":
      return {
        ...state,
        llmPanel: { ...panel, mode: action.mode },
      };
    case "llm_mode_set_to_active_route": {
      const mode = resolveModeFromActiveRoute(state);
      return {
        ...state,
        llmPanel: {
          ...panel,
          ...(mode ? { mode, syncModeToActiveRoute: false } : { syncModeToActiveRoute: true }),
        },
      };
    }
    case "llm_mode_toggled":
      return {
        ...state,
        llmPanel: { ...panel, mode: panel.mode === "local" ? "cloud" : "local" },
      };
    case "llm_cursor_set":
      if ((action.mode ?? panel.mode) === "cloud") {
        return {
          ...state,
          llmPanel: { ...panel, mode: "cloud", cloudCursor: Math.max(0, action.cursor) },
        };
      }
      return {
        ...state,
        llmPanel: {
          ...panel,
          mode: "local",
          localCursor: Math.max(0, action.cursor),
        },
      };
    case "llm_focus_set":
      return {
        ...state,
        llmPanel: {
          ...panel,
          mode: action.focus,
          ...(action.focus === "cloud"
            ? { cloudCursor: Math.max(0, action.cursor ?? panel.cloudCursor) }
            : { localCursor: Math.max(0, action.cursor ?? panel.localCursor) }),
        },
      };
    case "llm_stop_local_daemons_prompt_opened":
      return {
        ...state,
        llmPanel: {
          ...panel,
          stopLocalDaemonsPrompt: { providerId: action.providerId },
        },
      };
    case "llm_stop_local_daemons_prompt_closed":
      return {
        ...state,
        llmPanel: { ...panel, stopLocalDaemonsPrompt: null },
      };
    default:
      return state;
  }
}

export function resolveModeFromActiveRoute(state: TuiState): LlmPanelMode | null {
  const activeTextProvider = state.providersPanel.rows.find(
    (row) => row.isActiveText,
  );
  if (!activeTextProvider) return null;
  return activeTextProvider.kind !== "llama-server" ? "cloud" : "local";
}
