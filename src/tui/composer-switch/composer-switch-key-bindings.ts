import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import {
  selectComposerSwitchRow,
  type ComposerSwitchRow,
} from "./composer-switch-rows.js";
import {
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
 * Ctrl- and Meta-chords deliberately fall through — `ctrl+p` is the way
 * out of every surface in this app, and a switch that swallowed it would
 * be the one place that rule stopped holding.
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
    dispatch({ type: "composer_switch_closed" });
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
    moveSwitch(open.kind, key.rightArrow ? 1 : -1, dispatch);
    return true;
  }
  if (key.return) {
    activateSelection(ctx);
    return true;
  }
  // Everything else (Tab, letters, page keys) is swallowed so the
  // composer underneath cannot act on a key aimed at the switch.
  return true;
}

function moveSwitch(
  kind: ComposerSwitchKind,
  delta: number,
  dispatch: (action: TuiAction) => void,
): void {
  const next = neighbourSwitchKind(kind, delta);
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
