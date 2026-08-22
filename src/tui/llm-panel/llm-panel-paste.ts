import type { MouseContextValue } from "../mouse/mouse-context.js";
import { plainKey } from "../mouse/synthetic-key.js";
import { handleLlmPanelKey } from "./llm-panel-key-bindings.js";
import { handleLlmModalKey } from "./llm-panel-modal-key-bindings.js";

/**
 * Right-click paste into the Cloud pane's inline `filter:` row.
 *
 * The burst is routed through `handleLlmPanelKey` with the filter
 * treated as focused — pasting into a field IS focusing it, the way a
 * click into any input focuses it — so the text passes the same
 * printable-input discipline typing does. The state handed to the
 * handler carries the focus flag directly because the dispatch that
 * persists it only lands on the next render, and the handler must not
 * read the burst as letter hotkeys in the meantime.
 */
export function pasteIntoCloudModelFilter(
  text: string,
  mouse: MouseContextValue,
): void {
  const state = mouse.getState();
  if (state.uiMode !== "debug" || state.activeTab !== "llm") return;
  if (!state.llmPanel.cloudModelFilterFocused) {
    mouse.dispatch({ type: "llm_cloud_filter_focus_set", focused: true });
  }
  handleLlmPanelKey(text, plainKey(), {
    state: {
      ...state,
      llmPanel: {
        ...state.llmPanel,
        mode: "cloud",
        cloudModelFilterFocused: true,
      },
    },
    dispatch: mouse.dispatch,
    callbacks: mouse.callbacks,
  });
}

/**
 * Right-click paste into an LLM-tab modal's typed line — the chat-model
 * picker's `filter:` query, or the external llama.cpp URL draft. Both
 * are modals, so their field is already the focused surface — the burst
 * goes straight through the modal key layer, which applies the same
 * append discipline typing gets.
 */
export function pasteIntoLlmModalField(
  text: string,
  mouse: MouseContextValue,
): void {
  const state = mouse.getState();
  if (
    state.providersPanel.chatModelPicker === null &&
    state.llmPanel.externalUrlDraft === null
  ) {
    return;
  }
  handleLlmModalKey(text, plainKey(), {
    state,
    dispatch: mouse.dispatch,
    callbacks: mouse.callbacks,
  });
}
