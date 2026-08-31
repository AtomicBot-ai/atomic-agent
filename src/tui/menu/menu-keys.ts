import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { menuNodeByChord, type MenuNode } from "./menu-registry.js";
import { clampMenuCursor, selectMenuSelection } from "./menu-selectors.js";

/**
 * Prefix for direct jumps: `ctrl+g` then a single key. A leader is what
 * keeps the panels' own letter hotkeys (`r` refresh, `a` add, `d` remove …)
 * usable — the chord namespace is disjoint from both those letters and from
 * ordinary typing, so nothing had to be renamed to make room for it.
 *
 * `ctrl+g` rather than the `ctrl+x` opencode uses: `ctrl+x` is emacs' prefix
 * and is intercepted by some terminals.
 */
export const MENU_LEADER_LABEL = "ctrl+g";

export interface MenuKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  /** Run the node — navigate to a place, or run an action's slash command. */
  activate: (node: MenuNode) => void;
}

/** True when the keypress arms the `ctrl+g` leader. */
export function isMenuLeaderKey(input: string, key: Key): boolean {
  return key.ctrl && !key.meta && !key.shift && input === "g";
}

/**
 * Resolve the key pressed after the leader. Returns the node to activate,
 * or `null` when nothing claims that key — an unknown chord is swallowed
 * rather than falling through, so a mistyped leader can never land a stray
 * letter in the prompt or fire a panel hotkey.
 *
 * A chord is a *bare* key, same as the leader predicate above insists on
 * an unmodified `ctrl`. Ink reports `ctrl+c` as `input === "c"` with
 * `key.ctrl`, so without this guard the armed leader would read the abort
 * key as the MCP chord — and `ctrl+q` as quit, `ctrl+l` as the LLM tab.
 * Held modifiers mean the operator changed their mind, not that they typed
 * a chord.
 */
export function resolveLeaderChord(input: string, key: Key): MenuNode | null {
  if (key.escape || input.length === 0) return null;
  if (key.ctrl || key.meta) return null;
  return menuNodeByChord(input);
}

/**
 * Key layer for the open menu. Runs before every other handler, and claims
 * every printable key — the search box owns typing, which is why the list is
 * navigated with arrows only and never with `j`/`k`.
 *
 * Returns `true` when the key was consumed.
 */
export function handleMenuKey(
  input: string,
  key: Key,
  ctx: MenuKeyContext,
): boolean {
  const { state, dispatch } = ctx;
  if (!state.menuOpen) return false;

  if (key.escape) {
    dispatch({ type: "menu_closed" });
    return true;
  }
  if (key.downArrow) {
    dispatch({ type: "menu_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow) {
    dispatch({ type: "menu_cursor_moved", delta: -1 });
    return true;
  }

  const searching = state.menuQuery.trim().length > 0;
  const selection = selectMenuSelection(state);

  if (key.rightArrow) {
    if (!searching && selection?.node.kind === "submenu") {
      enterSubmenu(dispatch, selection.node.id);
    }
    return true;
  }
  if (key.leftArrow) {
    if (!searching && state.menuPath !== null) {
      dispatch({ type: "menu_path_set", path: null });
      dispatch({ type: "menu_cursor_set", cursor: 0 });
    }
    return true;
  }
  if (key.return) {
    if (!selection) return true;
    if (selection.node.kind === "submenu") {
      enterSubmenu(dispatch, selection.node.id);
      return true;
    }
    dispatch({ type: "menu_closed" });
    ctx.activate(selection.node);
    return true;
  }
  if (key.backspace || key.delete) {
    if (state.menuQuery.length > 0) {
      setQuery(dispatch, state.menuQuery.slice(0, -1));
    }
    return true;
  }
  if (isPrintable(input, key)) {
    setQuery(dispatch, state.menuQuery + input);
    return true;
  }
  // Anything else (Tab, page keys, stray control bytes) is swallowed so the
  // panel layer underneath cannot act on a key aimed at the menu.
  return true;
}

/** Clamp helper shared with the reducer so cursor moves stay in range. */
export function nextMenuCursor(state: TuiState, delta: number): number {
  return clampMenuCursor(state, state.menuCursor + delta);
}

function enterSubmenu(
  dispatch: (action: TuiAction) => void,
  id: string,
): void {
  dispatch({ type: "menu_path_set", path: id });
  dispatch({ type: "menu_cursor_set", cursor: 0 });
}

/**
 * Typing flattens the tree: a query ranks across the whole registry, so any
 * submenu the operator had walked into is dropped at the same time.
 */
function setQuery(
  dispatch: (action: TuiAction) => void,
  query: string,
): void {
  dispatch({ type: "menu_query_changed", query });
  dispatch({ type: "menu_cursor_set", cursor: 0 });
}

/**
 * Printable text destined for the search box.
 *
 * Accepts a whole burst, not just one character: a paste arrives as a single
 * input event, and so does fast typing under a slow render. Control bytes and
 * escape-sequence fragments are rejected per code point so a stray arrow can
 * never end up inside the query.
 */
function isPrintable(input: string, key: Key): boolean {
  if (input.length === 0) return false;
  if (key.ctrl || key.meta || key.tab || key.return || key.escape) return false;
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
