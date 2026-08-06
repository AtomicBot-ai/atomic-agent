import type { TuiState } from "../tui-state.js";
import { resolveModeFromActiveRoute } from "../llm-panel/llm-panel-reducer.js";
import { isProvidersAction } from "./providers-actions.js";
import { createInitialProvidersPanelState } from "./providers-panel-state.js";

export type { ProvidersAction } from "./providers-actions.js";
export { createInitialProvidersPanelState };

export function reduceProvidersPanel(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isProvidersAction(action)) return null;
  const panel = state.providersPanel;
  switch (action.type) {
    case "providers_refresh_requested":
      return state;
    case "providers_refresh":
      {
        const nextState = {
          ...state,
          providersPanel: {
            ...panel,
            rows: action.rows,
            cursor: Math.min(panel.cursor, Math.max(0, action.rows.length - 1)),
          },
        };
        if (!state.llmPanel.syncModeToActiveRoute) return nextState;
        const mode = resolveModeFromActiveRoute(nextState);
        if (!mode) return nextState;
        return {
          ...nextState,
          llmPanel: {
            ...nextState.llmPanel,
            mode,
            syncModeToActiveRoute: false,
          },
        };
      }
    case "providers_cursor_down":
      if (panel.rows.length === 0) return state;
      return {
        ...state,
        providersPanel: {
          ...panel,
          cursor: (panel.cursor + 1) % panel.rows.length,
        },
      };
    case "providers_cursor_up":
      if (panel.rows.length === 0) return state;
      return {
        ...state,
        providersPanel: {
          ...panel,
          cursor:
            (panel.cursor - 1 + panel.rows.length) % panel.rows.length,
        },
      };
    case "providers_status":
      return {
        ...state,
        providersPanel: { ...panel, statusLine: action.line },
      };
    case "providers_busy":
      return {
        ...state,
        providersPanel: { ...panel, busy: action.busy },
      };
    case "providers_wizard_opened":
      return {
        ...state,
        providersPanel: { ...panel, wizard: action.wizard },
      };
    case "providers_wizard_updated":
      if (panel.wizard === null) return state;
      return {
        ...state,
        providersPanel: { ...panel, wizard: action.wizard },
      };
    case "providers_wizard_closed":
      return {
        ...state,
        providersPanel: { ...panel, wizard: null },
      };
    case "providers_wizard_submit_started":
      if (panel.wizard === null) return state;
      return {
        ...state,
        providersPanel: {
          ...panel,
          wizard: { ...panel.wizard, submitting: true, error: null },
        },
      };
    case "providers_wizard_failed":
      if (panel.wizard === null) return state;
      return {
        ...state,
        providersPanel: {
          ...panel,
          wizard: {
            ...panel.wizard,
            submitting: false,
            error: action.error,
          },
        },
      };
    case "providers_wizard_succeeded":
      return {
        ...state,
        providersPanel: { ...panel, wizard: null },
      };
    case "providers_chat_model_picker_opened":
      return {
        ...state,
        providersPanel: {
          ...panel,
          chatModelPickerGeneration: action.generation,
          chatModelPicker: {
            providerId: action.providerId,
            currentModelId: action.currentModelId,
            status: "loading",
            models: [],
            cursor: 0,
            error: null,
            generation: action.generation,
          },
        },
      };
    case "providers_chat_model_picker_loaded": {
      // Generation-keyed: a response from a picker that was closed, or
      // reopened (even for the same provider) before its fetch settled,
      // must not repopulate the current one.
      if (
        !panel.chatModelPicker ||
        panel.chatModelPicker.generation !== action.generation
      ) {
        return state;
      }
      const currentIdx = panel.chatModelPicker.currentModelId
        ? action.models.indexOf(panel.chatModelPicker.currentModelId)
        : -1;
      return {
        ...state,
        providersPanel: {
          ...panel,
          chatModelPicker: {
            ...panel.chatModelPicker,
            status: "ready",
            models: action.models,
            cursor: currentIdx >= 0 ? currentIdx : 0,
            error: null,
          },
        },
      };
    }
    case "providers_chat_model_picker_failed": {
      if (
        !panel.chatModelPicker ||
        panel.chatModelPicker.generation !== action.generation
      ) {
        return state;
      }
      return {
        ...state,
        providersPanel: {
          ...panel,
          chatModelPicker: {
            ...panel.chatModelPicker,
            status: "error",
            error: action.error,
          },
        },
      };
    }
    case "providers_chat_model_picker_cursor_set": {
      if (!panel.chatModelPicker) return state;
      return {
        ...state,
        providersPanel: {
          ...panel,
          chatModelPicker: { ...panel.chatModelPicker, cursor: action.cursor },
        },
      };
    }
    case "providers_chat_model_picker_closed":
      return {
        ...state,
        providersPanel: { ...panel, chatModelPicker: null },
      };
    case "providers_remove_opened":
      return {
        ...state,
        providersPanel: {
          ...panel,
          removeConfirm: { id: action.id },
        },
      };
    case "providers_remove_closed":
      return {
        ...state,
        providersPanel: { ...panel, removeConfirm: null },
      };
    case "providers_remove_confirm_started":
      if (panel.removeConfirm === null) return state;
      return {
        ...state,
        providersPanel: { ...panel, busy: true },
      };
    case "providers_remove_failed":
      return {
        ...state,
        providersPanel: {
          ...panel,
          busy: false,
          removeConfirm: null,
          statusLine: action.error,
        },
      };
    case "providers_remove_succeeded":
      return {
        ...state,
        providersPanel: {
          ...panel,
          busy: false,
          removeConfirm: null,
        },
      };
    default:
      return null;
  }
}
