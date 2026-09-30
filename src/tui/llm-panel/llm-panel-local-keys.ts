import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { triggerLlmPrimary } from "./llm-panel-primary-actions.js";
import { selectLlmRowAt } from "./llm-panel-selectors.js";

/**
 * The Local pane's model keys: `g` pull the GGUF alone, `i` detail,
 * `d` delete, `x` stop the download in flight, `G` cycle the GPU
 * device, `U` toggle backend auto-update. They used to live only on the
 * standalone Models tab, which every route now redirects to this pane,
 * so none of them could be pressed (#546). None of the letters is taken
 * by the pane-wide hotkeys in `handleLlmPanelKey`.
 *
 * Returns `null` for keys it does not own, so the shared hotkeys run.
 */
export function handleLlmLocalPaneKey(
  input: string,
  key: Key,
  ctx: {
    state: TuiState;
    dispatch: (action: TuiAction) => void;
    callbacks: TuiAppCallbacks;
  },
): boolean | null {
  const { state, dispatch, callbacks } = ctx;
  if (state.llmPanel.mode !== "local") return null;
  const panel = state.localModelsPanel;
  const row = selectLlmRowAt(state);

  // The detail view replaces the list, so it owns every key: a letter
  // hotkey firing on a row nobody can see would be a surprise.
  if (panel.mode === "detail") {
    if (key.escape || input === "q") {
      dispatch({ type: "local_models_detail_closed" });
      return true;
    }
    if (key.return && row?.kind === "localTextModel") {
      triggerLlmPrimary(row, state, dispatch, callbacks);
      dispatch({ type: "local_models_detail_closed" });
    }
    return true;
  }

  // `x` stops the download in flight — chat first, then embedding — and
  // keeps what it fetched: Enter on the row resumes it.
  if (input === "x") {
    const kind = panel.pull ? "chat" : panel.embeddingPull ? "embedding" : null;
    if (!kind) return null;
    callbacks.onLocalModelsPullCancelRequested?.(kind);
    return true;
  }
  // `G` / `U` are pane-wide and ignore the cursor row. On shift so `G`
  // cannot be confused with the `g` GGUF-only pull.
  if (input === "G") {
    callbacks.onLocalModelsDeviceCycleRequested?.();
    return true;
  }
  if (input === "U") {
    callbacks.onLocalModelsAutoUpdateToggleRequested?.();
    return true;
  }

  if (row?.kind === "localTextModel") {
    if (input === "g") {
      // Enter is the key for "fill in what is missing"; `g` only ever
      // fetches weights that are not here yet, and never restarts a pull.
      const inFlight =
        panel.pull !== null &&
        !panel.pull.error &&
        panel.pull.kind === "chat" &&
        panel.pull.modelId === row.model.id;
      if (!row.model.downloaded && !inFlight) {
        callbacks.onLocalModelsPullRequested?.(row.model.id, "gguf-only");
      }
      return true;
    }
    if (input === "i") {
      dispatch({ type: "local_models_mode_set", mode: "detail" });
      return true;
    }
    if (input === "d" && row.model.downloaded) {
      dispatch({
        type: "local_models_remove_confirm_opened",
        id: row.model.id,
      });
      return true;
    }
  } else if (row?.kind === "localEmbeddingModel") {
    if (input === "d" && row.model.downloaded) {
      dispatch({
        type: "local_models_embedding_remove_confirm_opened",
        id: row.model.id,
      });
      return true;
    }
  }
  return null;
}
