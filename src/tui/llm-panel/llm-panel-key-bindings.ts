import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleLlmModalKey } from "./llm-panel-modal-key-bindings.js";
import { clampLlmCursor, selectLlmRowAt } from "./llm-panel-selectors.js";
import { cursorFieldFor } from "./llm-panel-state.js";
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

  // `/` bootstraps the global slash-command palette. The LLM tab keeps
  // the editor unfocused so single letters act as panel hotkeys, which
  // means typing `/` never reaches the editor's onChange. Seed the input
  // buffer and open the palette explicitly; `tui-app` re-focuses the
  // editor while the palette is open so the operator can finish typing.
  if (input === "/") {
    dispatch({ type: "input_changed", value: "/" });
    dispatch({ type: "slash_palette_opened", query: "" });
    return true;
  }

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
    switchLlmMode(state, dispatch, input === "[" || key.leftArrow ? -1 : 1);
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
  return state.llmPanel[cursorFieldFor(state.llmPanel.mode)];
}

