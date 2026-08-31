import type { Key } from "ink";

import { isPrintableFilterInput } from "../llm-panel/llm-panel-modal-key-bindings.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import {
  selectComposerBackend,
  selectComposerSwitchRow,
  type ComposerSwitchRow,
} from "./composer-switch-rows.js";
import {
  composerSwitchKindsFor,
  neighbourSwitchKind,
  type ComposerSwitchKind,
} from "./composer-switch-state.js";

/**
 * The key that opens the strip. `ctrl+r` was free in every layer: the
 * editor drops unhandled ctrl chords rather than inserting them, no
 * panel claims it, and it is not one of the three the editor forwards
 * (`ctrl+c` / `ctrl+o` / `ctrl+t`). "r" for route — the row it opens is
 * where the chat route is stated.
 */
export const COMPOSER_SWITCH_KEY_LABEL = "ctrl+r";

export interface ComposerSwitchKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  /** False while a panel modal, palette or approval owns the keyboard. */
  canOpen: boolean;
  /**
   * Runs the picked row. Supplied by `TuiApp` — the same callback the
   * popup's click handler gets — so a keypress and a click cannot drift
   * into two different activation paths.
   */
  activate: (row: ComposerSwitchRow) => void;
}

/** True when the keypress opens the composer's switch strip. */
export function isComposerSwitchOpenKey(input: string, key: Key): boolean {
  return key.ctrl && !key.meta && !key.shift && input === "r";
}

/**
 * Key layer for the composer's three switches.
 *
 * ←/→ walk the strip rather than closing it: the three controls sit side
 * by side on one row, and an operator who opened the wrong one should
 * not have to close, aim and reopen.
 *
 * Printable keys type into a substring filter (`composer-switch-filter`)
 * and Esc clears it before it closes anything — the model switch lists
 * 300+ catalog rows, and arrows alone were the only way across them.
 *
 * Ctrl- and Meta-chords deliberately fall through — `ctrl+c` must still
 * abort and the `ctrl+g` leader still arm from inside, and a switch that
 * swallowed a global chord would be the one place those rules stopped
 * holding.
 *
 * Returns `true` when the key was consumed.
 */
export function handleComposerSwitchKey(
  input: string,
  key: Key,
  ctx: ComposerSwitchKeyContext,
): boolean {
  const { state, dispatch } = ctx;
  const open = state.composerSwitch;
  if (!open) {
    if (!ctx.canOpen || !isComposerSwitchOpenKey(input, key)) return false;
    dispatch({ type: "composer_switch_opened", kind: "backend" });
    return true;
  }
  if (isComposerSwitchOpenKey(input, key)) {
    dispatch({ type: "composer_switch_closed" });
    return true;
  }
  if (key.ctrl || key.meta) return false;
  if (key.escape) {
    // Esc pays the filter before it pays the popup, the way the
    // wizard's search box does: undoing a mistyped query must not cost
    // the operator the list they were narrowing.
    if (open.filter.length > 0) {
      dispatch({ type: "composer_switch_filter_set", filter: "" });
    } else {
      dispatch({ type: "composer_switch_closed" });
    }
    return true;
  }
  if (key.downArrow) {
    dispatch({ type: "composer_switch_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow) {
    dispatch({ type: "composer_switch_cursor_moved", delta: -1 });
    return true;
  }
  if (key.leftArrow || key.rightArrow) {
    moveSwitch(state, open.kind, key.rightArrow ? 1 : -1, dispatch);
    return true;
  }
  if (key.return) {
    activateSelection(ctx);
    return true;
  }
  if (key.backspace || key.delete) {
    if (open.filter.length > 0) {
      dispatch({
        type: "composer_switch_filter_set",
        filter: open.filter.slice(0, -1),
      });
    }
    return true;
  }
  // Printable keys type into the filter — no `/` prefix, because unlike
  // the wizard's lists nothing here ever used letters for movement.
  if (input.length > 0 && isPrintableFilterInput(input)) {
    dispatch({
      type: "composer_switch_filter_set",
      filter: open.filter + input,
    });
    return true;
  }
  // Everything else (Tab, page keys) is swallowed so the composer
  // underneath cannot act on a key aimed at the switch.
  return true;
}

function moveSwitch(
  state: TuiState,
  kind: ComposerSwitchKind,
  delta: number,
  dispatch: (action: TuiAction) => void,
): void {
  // The walk visits the controls the strip draws for this backend —
  // on the managed-local route that is backend ⇄ model, no provider.
  const kinds = composerSwitchKindsFor(selectComposerBackend(state));
  const next = neighbourSwitchKind(kind, delta, kinds);
  if (next === kind) return;
  dispatch({ type: "composer_switch_opened", kind: next });
}

function activateSelection(ctx: ComposerSwitchKeyContext): void {
  const row = selectComposerSwitchRow(ctx.state);
  if (!row) {
    ctx.dispatch({ type: "composer_switch_closed" });
    return;
  }
  ctx.activate(row);
}
