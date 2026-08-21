import type { Key } from "ink";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

export interface ContextPanelKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
}

/**
 * Key layer for the open context panel.
 *
 * The panel is a readout: nothing to select, nothing to activate, so the
 * only bindings are the ways out. Esc is the app's universal dismiss;
 * `q` and Enter are here because a panel with no controls invites both.
 *
 * Every other *bare* key is swallowed rather than passed on. The editor
 * is unfocused while the panel owns input, so a stray letter would go
 * nowhere visible and then surprise the operator when it turned up in
 * the buffer. Modified keys fall through untouched — `ctrl+c` still
 * aborts a running turn from here.
 */
export function handleContextPanelKey(
  input: string,
  key: Key,
  ctx: ContextPanelKeyContext,
): boolean {
  const { state, dispatch } = ctx;
  if (!state.contextPanelOpen) return false;
  if (key.escape || key.return || input === "q") {
    dispatch({ type: "context_panel_closed" });
    return true;
  }
  return !key.ctrl && !key.meta;
}
