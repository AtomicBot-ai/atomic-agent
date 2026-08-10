import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  handleLlmModalKey,
  isPrintableFilterInput,
} from "./llm-panel-modal-key-bindings.js";
import { selectCloudModelSection } from "./llm-panel-row-builders.js";
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

  // Focused `filter:` row of the inline Cloud model list: printable keys
  // edit the filter, ↑/↓ walk the filtered models, Enter selects, Esc
  // unfocuses (the text stays). Letters are text here, so this branch
  // must run before every letter hotkey below.
  if (state.llmPanel.mode === "cloud" && state.llmPanel.cloudModelFilterFocused) {
    return handleCloudFilterKey(input, key, ctx);
  }

  // `f` drops into the inline model filter. From the Local/External
  // panes it first flips to Cloud, same pattern as `n`/`c`.
  if (input === "f") {
    dispatch({ type: "llm_mode_set", mode: "cloud" });
    dispatch({ type: "llm_cloud_filter_focus_set", focused: true });
    return true;
  }

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

/**
 * Key handling while the inline `filter:` row is focused. The list
 * cursor stays live the whole time — filtering and walking the results
 * never require leaving the filter row. Printable input follows the
 * same discipline as the modal picker's filter: navigation keys are
 * excluded by flag and control characters by code point, so escape
 * sequences can never land in the query.
 */
function handleCloudFilterKey(
  input: string,
  key: Key,
  ctx: LlmPanelKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const filter = state.llmPanel.cloudModelFilter;
  if (key.escape) {
    dispatch({ type: "llm_cloud_filter_focus_set", focused: false });
    return true;
  }
  if (key.upArrow || key.downArrow) {
    const section = selectCloudModelSection(state);
    if (section.filtered.length === 0) return true;
    const first = section.sectionStart;
    const last = section.sectionStart + section.filtered.length - 1;
    const delta = key.downArrow ? 1 : -1;
    const cursor = Math.min(last, Math.max(first, activeCursor(state) + delta));
    dispatch({ type: "llm_cursor_set", cursor });
    return true;
  }
  if (key.return) {
    const row = selectLlmRowAt(state);
    if (row?.kind !== "cloudChatModel") return true;
    // Selection ends the filtering session; the hotkey layer takes over.
    dispatch({ type: "llm_cloud_filter_focus_set", focused: false });
    triggerLlmPrimary(row, state, dispatch, callbacks);
    return true;
  }
  if (key.backspace || key.delete) {
    // Nothing to erase: dispatching would snap the cursor to the top of
    // the list for no reason, so swallow the key instead.
    if (filter.length === 0) return true;
    dispatch({ type: "llm_cloud_filter_set", value: filter.slice(0, -1) });
    return true;
  }
  const isNavigationKey =
    key.tab ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown;
  if (
    input.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    !isNavigationKey &&
    isPrintableFilterInput(input)
  ) {
    dispatch({ type: "llm_cloud_filter_set", value: filter + input });
    return true;
  }
  return true;
}

