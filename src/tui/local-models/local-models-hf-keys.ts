import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";

export interface LocalModelsHfKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keys for "add a model from Hugging Face" — the branch the first-run
 * flow always had, now reachable from the local-models pane as well.
 *
 * Its own module because two key tables call it: `Manage › LLM › Local`
 * (`llm-panel-key-bindings.ts`), which is where an operator actually
 * lands, and the older Models tab (`local-models-key-bindings.ts`).
 * One handler means the two cannot drift into disagreeing about what
 * Escape does mid-lookup.
 *
 * Returns `null` when the branch is not open, so a caller can fall
 * through to its own keys; `true`/`false` once it is.
 *
 * **Both steps swallow every key they do not name.** The reference
 * editor reads its own input through Ink, and letting a stray `s` or
 * `d` fall through to the list's hotkeys under an open editor would
 * start a daemon or open a delete confirm while the operator was typing
 * a repo name.
 */
export function handleLocalModelsHfKey(
  input: string,
  key: Key,
  ctx: LocalModelsHfKeyContext,
): boolean | null {
  const panel = ctx.state.localModelsPanel;
  if (panel.mode === "hfRef") {
    if (key.escape) {
      // Escape means "stop the request" while one is in flight and
      // "leave the branch" once it is not — one key, the least
      // destructive reading first.
      if (panel.hf.busy) {
        ctx.callbacks.onLocalModelsHfLookupCancelRequested?.();
      } else {
        ctx.dispatch({ type: "local_models_hf_closed" });
      }
      return true;
    }
    // Ctrl+l, not ctrl+u: the editor binds ctrl+u to kill-to-line-start
    // and Ink handlers do not consume, so a screen-level ctrl+u would
    // double-fire against the focused editor.
    if (key.ctrl && input === "l" && !panel.hf.busy) {
      ctx.dispatch({ type: "local_models_hf_reference_changed", value: "" });
      return true;
    }
    return true;
  }
  if (panel.mode === "hfPick") {
    if (key.escape) {
      // Back to the reference, not out of the branch: the resolved repo
      // survives on the slice, so returning to the file list costs no
      // second request.
      ctx.dispatch({ type: "local_models_mode_set", mode: "hfRef" });
      return true;
    }
    if (key.upArrow || input === "k") {
      ctx.dispatch({ type: "local_models_hf_cursor_moved", delta: -1 });
      return true;
    }
    if (key.downArrow || input === "j") {
      ctx.dispatch({ type: "local_models_hf_cursor_moved", delta: 1 });
      return true;
    }
    if (key.return && panel.hf.repo) {
      ctx.callbacks.onLocalModelsHfAddRequested?.(panel.hf.repo, panel.hf.cursor);
      return true;
    }
    return true;
  }
  return null;
}

/** Whether the branch owns the surface right now. */
export function isLocalModelsHfOpen(state: TuiState): boolean {
  const { mode } = state.localModelsPanel;
  return mode === "hfRef" || mode === "hfPick";
}
