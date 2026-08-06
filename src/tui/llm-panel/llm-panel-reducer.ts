import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isLlmPanelAction } from "./llm-panel-actions.js";
import { cursorFieldFor, LLM_PANEL_MODES, type LlmPanelMode } from "./llm-panel-state.js";

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
        llmPanel: { ...panel, mode: nextMode(panel.mode, 1) },
      };
    case "llm_cursor_set": {
      const mode = action.mode ?? panel.mode;
      return {
        ...state,
        llmPanel: {
          ...panel,
          mode,
          [cursorFieldFor(mode)]: Math.max(0, action.cursor),
        },
      };
    }
    case "llm_focus_set": {
      const field = cursorFieldFor(action.focus);
      return {
        ...state,
        llmPanel: {
          ...panel,
          mode: action.focus,
          [field]: Math.max(0, action.cursor ?? panel[field]),
        },
      };
    }
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
    case "llm_external_url_draft_set":
      return {
        ...state,
        llmPanel: { ...panel, externalUrlDraft: action.value },
      };
    case "llm_model_picker_opened":
      return {
        ...state,
        llmPanel: {
          ...panel,
          modelPicker: {
            providerId: action.providerId,
            currentModelId: action.currentModelId,
            status: "loading",
            models: [],
            cursor: 0,
            error: null,
          },
        },
      };
    case "llm_model_picker_loaded": {
      // A stale fetch (picker closed or reopened for another provider)
      // must not resurrect or repoint the modal.
      if (!panel.modelPicker || panel.modelPicker.providerId !== action.providerId) {
        return state;
      }
      const currentIdx = panel.modelPicker.currentModelId
        ? action.models.indexOf(panel.modelPicker.currentModelId)
        : -1;
      return {
        ...state,
        llmPanel: {
          ...panel,
          modelPicker: {
            ...panel.modelPicker,
            status: "ready",
            models: action.models,
            cursor: currentIdx >= 0 ? currentIdx : 0,
            error: null,
          },
        },
      };
    }
    case "llm_model_picker_failed": {
      if (!panel.modelPicker || panel.modelPicker.providerId !== action.providerId) {
        return state;
      }
      return {
        ...state,
        llmPanel: {
          ...panel,
          modelPicker: { ...panel.modelPicker, status: "error", error: action.error },
        },
      };
    }
    case "llm_model_picker_cursor_set": {
      if (!panel.modelPicker) return state;
      return {
        ...state,
        llmPanel: {
          ...panel,
          modelPicker: { ...panel.modelPicker, cursor: action.cursor },
        },
      };
    }
    case "llm_model_picker_closed":
      return {
        ...state,
        llmPanel: { ...panel, modelPicker: null },
      };
    default:
      return state;
  }
}

/** Step `delta` panes from `mode`, wrapping at both ends. */
export function nextMode(mode: LlmPanelMode, delta: number): LlmPanelMode {
  const at = LLM_PANEL_MODES.indexOf(mode);
  const len = LLM_PANEL_MODES.length;
  return LLM_PANEL_MODES[(at + delta + len) % len] ?? mode;
}

export function resolveModeFromActiveRoute(state: TuiState): LlmPanelMode | null {
  const activeTextProvider = state.providersPanel.rows.find(
    (row) => row.isActiveText,
  );
  if (!activeTextProvider) return null;
  return activeTextProvider.kind !== "llama-server" ? "cloud" : "local";
}
