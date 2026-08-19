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
    case "llm_cloud_filter_focus_set": {
      if (!action.focused) {
        return {
          ...state,
          llmPanel: {
            ...panel,
            cloudModelFilterFocused: false,
            pendingCloudFilterFocus: false,
          },
        };
      }
      if (panel.mode === "cloud") return focusCloudModelFilter(state);
      // The pane is not Cloud. Two very different reasons for that, and
      // they must not be treated alike:
      //
      //  - the route resolved to `local`, so /model legitimately landed
      //    on the Local pane and the tab switch is the whole effect
      //    (`f` flips the pane to cloud explicitly before this);
      //  - the route has not resolved yet, because `providersPanel.rows`
      //    was still empty when `llm_mode_set_to_active_route` ran one
      //    action earlier — the first /model of a session. Dropping the
      //    request there left the operator on a Cloud pane whose filter
      //    was not focused and whose cursor still pointed at a provider
      //    row above the list, so the first ↑/↓ was spent climbing into
      //    the section and looked like a swallowed keypress.
      if (!panel.syncModeToActiveRoute) return state;
      return {
        ...state,
        llmPanel: { ...panel, pendingCloudFilterFocus: true },
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

/**
 * Give the `filter:` row of the inline Cloud list the keyboard and drop
 * the cursor into the model section, so ↑/↓ and Enter act on models
 * immediately. The section lists the current model first; when the
 * cursor is already inside the section, leave it where the operator put
 * it.
 *
 * Shared with `providers_refresh` (see `providers-reducer.ts`): the
 * route that /model asks for can only be resolved once provider rows
 * exist, and this is the half of the request that has to wait for them.
 */
export function focusCloudModelFilter(state: TuiState): TuiState {
  const panel = state.llmPanel;
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
      pendingCloudFilterFocus: false,
      cloudCursor: cursorInSection ? panel.cloudCursor : section.sectionStart,
    },
  };
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
