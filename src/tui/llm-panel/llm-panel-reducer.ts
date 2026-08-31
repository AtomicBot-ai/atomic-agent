import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isLlmPanelAction } from "./llm-panel-actions.js";
import { selectCloudModelSection } from "./llm-panel-row-builders.js";
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
    case "llm_external_compat_steer_opened":
      return {
        ...state,
        llmPanel: { ...panel, externalCompatSteerUrl: action.url },
      };
    case "llm_external_compat_steer_closed":
      return {
        ...state,
        llmPanel: { ...panel, externalCompatSteerUrl: null },
      };
    case "llm_cloud_filter_focus_set": {
      if (!action.focused) {
        return {
          ...state,
          llmPanel: { ...panel, cloudModelFilterFocused: false },
        };
      }
      // Focus only applies to the Cloud pane: /model on a local route
      // dispatches this right after `llm_mode_set_to_active_route`
      // resolved to `local`, and there the tab switch is the whole
      // effect. (`f` flips the pane to cloud explicitly before this.)
      if (panel.mode !== "cloud") return state;
      // Focusing the filter drops the cursor into the model section so
      // ↑/↓ and Enter act on models immediately. The section lists the
      // current model first; when the cursor is already inside the
      // section, leave it where the operator put it.
      const section = selectCloudModelSection(state);
      const sectionEnd = section.sectionStart + section.filtered.length - 1;
      const cursorInSection =
        panel.cloudCursor >= section.sectionStart &&
        panel.cloudCursor <= sectionEnd;
      return {
        ...state,
        llmPanel: {
          ...panel,
          cloudModelFilterFocused: true,
          cloudCursor: cursorInSection ? panel.cloudCursor : section.sectionStart,
        },
      };
    }
    case "llm_cloud_filter_set": {
      // Every edit re-filters, so the cursor snaps to the top of the new
      // result set — same rule the modal picker used.
      const next: TuiState = {
        ...state,
        llmPanel: { ...panel, cloudModelFilter: action.value },
      };
      const section = selectCloudModelSection(next);
      return {
        ...next,
        llmPanel: {
          ...next.llmPanel,
          cloudCursor: section.sectionStart,
        },
      };
    }
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
