import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

/**
 * Which surface a click outside every popup should close, and how.
 *
 * Extracted from the handler in `tui-app.tsx` because it is a *policy*
 * — one ordered list of "what is open, and what cancels it" — and it was
 * the half of that handler nothing could reach: the surrounding closure
 * also does grace-period timing, wheel swallowing and a live-preview
 * revert, none of which a test wants to stand up in order to ask which
 * action a given state should produce.
 *
 * **The order is the precedence.** Surfaces stack — an uninstall confirm
 * opens from the menu, the menu can open over the slash palette — and
 * the innermost one is the one a click outside should take. That is why
 * this is a chain rather than a lookup: the same click means "cancel the
 * uninstall" and "leave the menu alone" at the same time.
 *
 * Returns `null` when nothing is open, which is the caller's signal to
 * decline the event so it falls through to whatever is underneath.
 */
export function resolveBackdropDismissal(state: TuiState): TuiAction | null {
  if (state.uninstall) return { type: "uninstall_closed" };
  if (state.sessionDelete) return { type: "session_delete_closed" };
  if (state.contextPanelOpen) return { type: "context_panel_closed" };
  if (state.composerSwitch) return { type: "composer_switch_closed" };
  if (state.codingModeMenu) return { type: "coding_mode_menu_closed" };
  if (state.menuOpen) return { type: "menu_closed" };
  // The three pickers were missing from this list, and that is the whole
  // bug: `modalOwnsInput` raises the mouse floor for them, so while one
  // was open every control on screen stopped answering — and nothing
  // took the click that would have closed it either. The picker was not
  // "modal", it was a hole in the app that only the keyboard could climb
  // out of.
  if (state.themePickerOpen) return { type: "theme_picker_closed" };
  if (state.sessionPickerOpen) return { type: "session_picker_closed" };
  if (state.slashPaletteOpen) return { type: "slash_palette_closed" };
  return null;
}

/**
 * True when closing `state`'s frontmost surface has to put the palette
 * back first.
 *
 * The theme picker previews live — the arrow keys swap the real theme so
 * you can see it — so cancelling it is two steps, and the second one is
 * not a reducer action: `setActiveTheme` is a module singleton, not
 * state. Esc has always done both; a click outside has to as well, or
 * dismissing the picker would silently *apply* whatever was under the
 * cursor.
 */
export function backdropRevertsThemePreview(state: TuiState): boolean {
  return (
    resolveBackdropDismissal(state)?.type === "theme_picker_closed"
  );
}
