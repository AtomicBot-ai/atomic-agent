import type { TuiState } from "../tui-state.js";

/**
 * The right-click cut/copy/paste menu's reducer slice and its pure
 * rules. The slice stores WHERE the menu is (the clicked screen cell)
 * and WHAT it targets; the callable actions cannot live in the reducer
 * (they close over one component's private buffer state), so they ride
 * in `context-menu-context.tsx` beside this slice.
 */

export type ContextMenuTarget =
  /** A `MultiLineEditor` buffer: cut/copy exist, gated on a selection. */
  | { readonly kind: "editor"; readonly hasSelection: boolean }
  /** A hand-rolled typed field (wizard lines, filter/search buffers):
   * append-only, no selection exists, so the menu is paste-only. */
  | { readonly kind: "field" };

export interface ContextMenuState {
  /** 0-based terminal column of the click cell — the anchor. */
  readonly x: number;
  /** 0-based terminal row of the click cell. */
  readonly y: number;
  readonly target: ContextMenuTarget;
}

export type ContextMenuItemId = "cut" | "copy" | "paste";

/**
 * Availability exactly as specified: paste always; cut/copy only when a
 * selection exists. Caret-only right-clicks OMIT cut/copy rather than
 * greying them — a two-thirds-dead three-row menu is noise on a screen
 * where every row costs a terminal line.
 */
export function contextMenuItems(
  target: ContextMenuTarget,
): readonly ContextMenuItemId[] {
  if (target.kind === "editor" && target.hasSelection) {
    return ["cut", "copy", "paste"];
  }
  return ["paste"];
}

/**
 * True while a floating overlay owns the screen. Openers consult this
 * because layer floors cannot: a paste field inside the providers
 * wizard registers at the MODAL layer to be reachable while its wizard
 * owns input, which also makes it hit-testable through the operator
 * menu floating on the same layer — and a context menu for a field the
 * menu is covering would act on something the operator cannot see.
 * Fields that belong to one of these overlays (the menu's own query,
 * the composer switch's filter) skip the guard: they only render while
 * their overlay is up, and the overlays are mutually exclusive by
 * reducer rule ("one overlay at a time", `menu_opened`).
 */
export function contextMenuBlockedByOverlay(state: TuiState): boolean {
  return (
    state.menuOpen ||
    state.contextPanelOpen ||
    state.composerSwitch !== null ||
    state.sessionDelete !== null ||
    state.themePickerOpen ||
    state.sessionPickerOpen ||
    state.updatePrompt !== null ||
    state.updateStatus === "done"
  );
}

/**
 * Strip control characters (newlines included) from text pasted into a
 * single-line field. The fields' own key handlers reject a burst that
 * contains any control byte (`isPrintableFilterInput`) or append it
 * verbatim (the wizard lines); a clipboard string with a trailing
 * newline — the single most common shape of a copied line — would
 * either vanish or corrupt the buffer. Editors keep their newlines:
 * this is only for the paste-only fields.
 */
export function stripFieldPasteControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) continue;
    out += char;
  }
  return out;
}
