import type { Key } from "ink";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

export interface ContextPanelKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  /**
   * Switches the transcript cap to auto — the same handler the panel's
   * `set auto` button calls. A callback rather than an action because
   * the work is a config write, and the reducer is pure.
   *
   * Optional so existing callers (and the key tests) need not supply
   * one; `a` is then swallowed like any other bare key.
   */
  onSetCapAuto?: () => void;
  /**
   * Step the task count by `delta`. Optional: a surface with no config
   * writer simply swallows the key.
   */
  onStepPairs?: (delta: number) => void;
}

/**
 * Key layer for the open context panel.
 *
 * The panel is very nearly a readout: nothing to select, and one thing
 * to activate. Esc is the app's universal dismiss; `q` and Enter are
 * here because a panel with almost no controls invites both.
 *
 * `a` switches the transcript cap to auto — the keyboard route to the
 * `set auto` button. Bound unconditionally rather than only when the
 * button is showing: the panel does not know whether it is, the
 * reducer's guard is the one that decides, and a key that silently did
 * nothing on the wrong screen is cheaper than two places disagreeing
 * about when it applies.
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
  // `-` / `+` work the selector. Each step is applied, not staged: the
  // control *is* the setting, and a selector that needed a second key
  // to mean anything would be a form, not a dial. Arrow keys are not
  // used — they would read as navigation in a panel with nothing to
  // navigate.
  if (input === "-" || input === "_") {
    ctx.onStepPairs?.(-1);
    return true;
  }
  if (input === "+" || input === "=") {
    ctx.onStepPairs?.(1);
    return true;
  }
  return !key.ctrl && !key.meta;
}
