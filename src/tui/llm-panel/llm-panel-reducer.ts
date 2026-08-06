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
    case "llm_hf_prompt_opened":
      return {
        ...state,
        llmPanel: {
          ...panel,
          huggingFacePrompt: {
            buffer: "",
            busy: false,
            error: null,
            results: [],
          },
        },
      };
    case "llm_hf_prompt_buffer_changed":
      if (!panel.huggingFacePrompt) return state;
      return {
        ...state,
        llmPanel: {
          ...panel,
          huggingFacePrompt: {
            ...panel.huggingFacePrompt,
            buffer: action.buffer,
            error: null,
          },
        },
      };
    case "llm_hf_prompt_busy_set":
      if (!panel.huggingFacePrompt) return state;
      return {
        ...state,
        llmPanel: {
          ...panel,
          huggingFacePrompt: { ...panel.huggingFacePrompt, busy: action.busy },
        },
      };
    case "llm_hf_prompt_failed":
      if (!panel.huggingFacePrompt) return state;
      return {
        ...state,
        llmPanel: {
          ...panel,
          huggingFacePrompt: {
            ...panel.huggingFacePrompt,
            busy: false,
            error: action.error,
          },
        },
      };
    case "llm_hf_prompt_results_set":
      if (!panel.huggingFacePrompt) return state;
      return {
        ...state,
        llmPanel: {
          ...panel,
          huggingFacePrompt: {
            ...panel.huggingFacePrompt,
            busy: false,
            error: null,
            results: action.results,
          },
        },
      };
    case "llm_hf_prompt_closed":
      return {
        ...state,
        llmPanel: { ...panel, huggingFacePrompt: null },
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
