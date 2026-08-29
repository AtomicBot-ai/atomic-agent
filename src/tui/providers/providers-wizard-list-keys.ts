import type { Key } from "ink";
import { PICK_WINDOW } from "../components/wizard-pick-list.js";
import { isPrintableFilterInput } from "../llm-panel/llm-panel-modal-key-bindings.js";
import { clampCursor, isListPhase } from "./providers-wizard-phases.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/** The key that opens the search box on a list screen. */
const SEARCH_OPEN_KEY = "/";

/**
 * Cursor after one list-navigation key, or `null` when the key is not a
 * navigation key. Every result starts from the clamped cursor so a
 * catalog that shrank under an open wizard cannot leave the cursor
 * pointing past the end (see `clampCursor`). Arrows wrap; PgUp/PgDn jump
 * one viewport (`PICK_WINDOW`) and stop at the edges, Home/End go
 * straight to them. Arrow-only travel to row 250 of a 300+ catalog was
 * the alternative.
 */
export function nextListCursor(
  input: string,
  key: Key,
  cursor: number,
  length: number,
  withVimKeys: boolean,
): number | null {
  const current = clampCursor(cursor, length);
  const last = Math.max(0, length - 1);
  if (key.downArrow || (withVimKeys && input === "j")) {
    return (current + 1) % length;
  }
  if (key.upArrow || (withVimKeys && input === "k")) {
    return (current - 1 + length) % length;
  }
  if (key.pageDown) return Math.min(current + PICK_WINDOW, last);
  if (key.pageUp) return Math.max(current - PICK_WINDOW, 0);
  if (key.home) return 0;
  if (key.end) return last;
  return null;
}

/** Keys that move or commit, and so never type into the search box. */
function isNavigationKey(key: Key): boolean {
  return (
    key.tab ||
    key.return ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  );
}

/**
 * The next wizard state when the key belongs to the search box, or
 * `null` when the caller should go on handling it.
 *
 * The box is opened with `/` rather than typing straight into the list.
 * `j` and `k` are the documented movement keys on all three list
 * screens, and a box that always swallowed them would make one letter
 * mean two different things depending on state the operator cannot see.
 * Once it is open every printable key — `j` and `k` included — goes into
 * the query, movement falls back to the arrows and PgUp/PgDn, and Esc
 * empties and closes the box; a second Esc leaves the screen exactly as
 * it always did.
 */
export function handleWizardSearchKey(
  input: string,
  key: Key,
  wizard: ProvidersWizardState,
): ProvidersWizardState | null {
  if (!isListPhase(wizard.phase)) return null;
  const search = wizard.search;
  if (search === null) {
    if (input === SEARCH_OPEN_KEY && !key.ctrl && !key.meta) {
      return { ...wizard, search: "", cursor: 0 };
    }
    return null;
  }
  // Closing and clearing are one action: a filter still applied behind a
  // box that is no longer on screen leaves the list looking half empty
  // for a reason nothing on the screen explains.
  if (key.escape) return { ...wizard, search: null, cursor: 0 };
  if (key.backspace || key.delete) {
    if (search.length === 0) return { ...wizard, search: null, cursor: 0 };
    return { ...wizard, search: search.slice(0, -1), cursor: 0 };
  }
  if (isNavigationKey(key)) return null;
  if (
    input.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    isPrintableFilterInput(input)
  ) {
    // The cursor returns to the top of the result set rather than being
    // clamped where it stood: once a keystroke changes the list, row 200
    // of the old one is not a row the operator was looking at.
    return { ...wizard, search: search + input, cursor: 0 };
  }
  return null;
}
