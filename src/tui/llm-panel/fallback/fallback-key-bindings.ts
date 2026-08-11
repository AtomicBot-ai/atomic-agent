import type { Key } from "ink";
import type { TuiAction } from "../../tui-action.js";
import type { TuiState } from "../../tui-state.js";
import { clampFallbackCursor, fallbackRowAt } from "./fallback-rows.js";

/**
 * Key handling for the Fallback pane, routed from `handleLlmPanelKey`
 * when `state.llmPanel.mode === "fallback"`. Returns true when the key
 * was consumed here, false to let the shared LLM-panel hotkeys (`[`/`]`
 * pane switch, `r` refresh, `/`, `L`, ...) run.
 *
 * Bindings (chosen not to collide with the LLM tab's existing letters —
 * `f` filter, `n` add provider, `c` configure, `e`/`E` embedding, `s`
 * daemon, `B` backend, `L` logs, `r` refresh):
 *  - `j` / `k` (and ↓/↑): move the row cursor.
 *  - `<` / `>`: move the selected link up / down in priority. Clamped at
 *    the ends and refused for the auto-appended local link.
 *  - `a` (or Enter): open the add-link picker.
 *  - `d`: remove the selected link (refused for the active head and the
 *    appended local link).
 *  - `l`: toggle `appendLocal`.
 * While the add-link picker owns the keyboard: ↑/↓/j/k move, Enter adds,
 * Esc cancels.
 */
export function handleFallbackPaneKey(
  input: string,
  key: Key,
  ctx: { state: TuiState; dispatch: (action: TuiAction) => void },
): boolean {
  const { state, dispatch } = ctx;
  const panel = state.fallbackPanel;

  if (panel.addPicker) {
    return handleAddPickerKey(input, key, ctx);
  }

  if (key.downArrow || input === "j") {
    dispatch({
      type: "llm_cursor_set",
      cursor: clampFallbackCursor(state, fallbackCursor(state) + 1),
    });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({
      type: "llm_cursor_set",
      cursor: clampFallbackCursor(state, fallbackCursor(state) - 1),
    });
    return true;
  }

  if (input === "<" || input === ">") {
    const row = fallbackRowAt(state);
    if (row?.kind === "link") {
      dispatch({
        type: "fallback_move_requested",
        providerId: row.link.providerId,
        delta: input === "<" ? -1 : 1,
      });
    }
    return true;
  }

  if (input === "a" || key.return) {
    dispatch({ type: "fallback_add_picker_opened" });
    return true;
  }

  if (input === "d") {
    const row = fallbackRowAt(state);
    if (row?.kind === "link") {
      dispatch({
        type: "fallback_remove_requested",
        providerId: row.link.providerId,
      });
    }
    return true;
  }

  if (input === "l") {
    dispatch({ type: "fallback_append_local_toggle_requested" });
    return true;
  }

  return false;
}

function handleAddPickerKey(
  input: string,
  key: Key,
  ctx: { state: TuiState; dispatch: (action: TuiAction) => void },
): boolean {
  const { state, dispatch } = ctx;
  const picker = state.fallbackPanel.addPicker;
  if (!picker) return false;
  const options = state.fallbackPanel.addableProviderIds;

  if (key.escape) {
    dispatch({ type: "fallback_add_picker_closed" });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({ type: "fallback_add_picker_cursor_set", cursor: picker.cursor + 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "fallback_add_picker_cursor_set", cursor: picker.cursor - 1 });
    return true;
  }
  if (key.return) {
    const providerId = options[picker.cursor];
    if (providerId) {
      dispatch({ type: "fallback_add_requested", providerId });
    }
    dispatch({ type: "fallback_add_picker_closed" });
    return true;
  }
  // Any other key is swallowed while the picker owns the keyboard.
  return true;
}

function fallbackCursor(state: TuiState): number {
  return state.llmPanel.fallbackCursor;
}
