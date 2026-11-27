import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";

export interface ModelsDirKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * ATO-2504: keys of the models folder screen, shared by the Models tab
 * and Manage › LLM › Local, like `local-models-hf-keys.ts`. The folder is
 * typed into a real editor (its own Enter submits), so every key the
 * screen does not name is swallowed: a stray `s` must not start a model
 * while a path is being typed. Esc stops a move under way (the agent puts
 * every model back) and otherwise goes back to the list.
 *
 * `null` when the screen is not open.
 */
export function handleModelsDirKey(input: string, key: Key, ctx: ModelsDirKeyContext): boolean | null {
  const panel = ctx.state.localModelsPanel;
  if (panel.mode !== "modelsDir") return null;
  if (key.escape) {
    if (panel.modelsDir.moving) {
      if (!panel.modelsDir.stopping) ctx.callbacks.onLocalModelsDirCancelRequested?.();
    } else {
      ctx.dispatch({ type: "local_models_dir_closed" });
    }
    return true;
  }
  if (key.ctrl && input === "l" && !panel.modelsDir.moving) {
    ctx.dispatch({ type: "local_models_dir_draft_changed", value: "" });
    return true;
  }
  return true;
}

/** `F` on the list: open the screen and ask the agent where the folder is. */
export function openModelsDir(ctx: Pick<ModelsDirKeyContext, "dispatch" | "callbacks">): void {
  ctx.dispatch({ type: "local_models_dir_opened" });
  ctx.callbacks.onLocalModelsDirLoadRequested?.();
}

export function isModelsDirOpen(state: TuiState): boolean {
  return state.localModelsPanel.mode === "modelsDir";
}
