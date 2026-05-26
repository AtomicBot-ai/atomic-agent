import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleLlmModalKey } from "./llm-panel-modal-key-bindings.js";
import { clampLlmCursor, selectLlmRowAt } from "./llm-panel-selectors.js";
import {
  activateProviderEmbedding,
  openAddProvider,
  openProviderConfig,
  switchLlmMode,
  triggerDaemonAction,
  triggerLlmPrimary,
} from "./llm-panel-primary-actions.js";

export interface LlmPanelKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

export function handleLlmPanelKey(
  input: string,
  key: Key,
  ctx: LlmPanelKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "llm") return false;

  const modalHandled = handleLlmModalKey(input, key, ctx);
  if (modalHandled !== null) return modalHandled;

  if (key.downArrow || input === "j") {
    const cursor = clampLlmCursor(state, activeCursor(state) + 1);
    dispatch({ type: "llm_cursor_set", cursor });
    return true;
  }
  if (key.upArrow || input === "k") {
    const cursor = clampLlmCursor(state, activeCursor(state) - 1);
    dispatch({ type: "llm_cursor_set", cursor });
    return true;
  }

  const row = selectLlmRowAt(state);

  if (key.return) {
    triggerLlmPrimary(row, state, dispatch, callbacks);
    return true;
  }
  if (input === "[" || input === "]" || key.leftArrow || key.rightArrow) {
    switchLlmMode(state, dispatch);
    return true;
  }
  if (input === "e") {
    activateProviderEmbedding(state, callbacks);
    return true;
  }
  if (input === "E") {
    callbacks.onLocalModelsEmbeddingToggleEnabledRequested?.();
    return true;
  }
  if (input === "n") {
    dispatch({ type: "llm_mode_set", mode: "cloud" });
    openAddProvider(dispatch);
    return true;
  }
  if (input === "c") {
    dispatch({ type: "llm_mode_set", mode: "cloud" });
    openProviderConfig(state, dispatch);
    return true;
  }
  if (input === "s") {
    triggerDaemonAction(state, callbacks);
    return true;
  }
  if (input === "B") {
    callbacks.onLocalModelsBackendPullRequested?.();
    return true;
  }
  if (input === "L") {
    dispatch({ type: "tab_changed", tab: "llm-logs" });
    return true;
  }
  if (input === "r") {
    callbacks.onProvidersTabRefresh?.();
    callbacks.onLocalModelsRefreshRequested?.();
    return true;
  }
  return false;
}

function activeCursor(state: TuiState): number {
  return state.llmPanel.mode === "cloud"
    ? state.llmPanel.cloudCursor
    : state.llmPanel.localCursor;
}

