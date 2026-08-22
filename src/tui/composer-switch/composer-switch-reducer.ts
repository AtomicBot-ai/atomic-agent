import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isComposerSwitchAction } from "./composer-switch-actions.js";
import {
  clampComposerSwitchCursor,
  initialComposerSwitchCursor,
} from "./composer-switch-rows.js";

/**
 * Folds the composer switch strip. Returns `null` for anything else so
 * `reduceTuiState` can carry on down its own chain.
 */
export function reduceComposerSwitchAction(
  state: TuiState,
  action: TuiAction,
): TuiState | null {
  if (!isComposerSwitchAction(action)) return null;
  switch (action.type) {
    case "composer_switch_opened":
      return {
        ...state,
        composerSwitch: {
          kind: action.kind,
          // Land on the choice already in effect: the switch is a
          // statement of what the route is before it is a way to change
          // it, and one Enter on an unmoved cursor must be a no-op.
          // Computed against a closed switch so a filter still typed in
          // the previous one cannot decide where the fresh list lands.
          cursor: initialComposerSwitchCursor(
            { ...state, composerSwitch: null },
            action.kind,
          ),
          filter: "",
        },
        // One overlay at a time. Two absolutely-positioned panels in a
        // terminal do not stack, they interleave.
        menuOpen: false,
        contextPanelOpen: false,
      };
    case "composer_switch_closed":
      return { ...state, composerSwitch: null };
    case "composer_switch_cursor_moved": {
      if (!state.composerSwitch) return state;
      return {
        ...state,
        composerSwitch: {
          ...state.composerSwitch,
          cursor: clampComposerSwitchCursor(
            state,
            state.composerSwitch.cursor + action.delta,
          ),
        },
      };
    }
    case "composer_switch_cursor_set": {
      if (!state.composerSwitch) return state;
      return {
        ...state,
        composerSwitch: {
          ...state.composerSwitch,
          cursor: clampComposerSwitchCursor(state, action.cursor),
        },
      };
    }
    case "composer_switch_filter_set": {
      if (!state.composerSwitch) return state;
      return {
        ...state,
        composerSwitch: {
          ...state.composerSwitch,
          filter: action.filter,
          // Back to the top, not clamped in place: once a keystroke
          // changes the list, row 200 of the old one is not a row the
          // operator was looking at (same call the wizard's search makes).
          cursor: 0,
        },
      };
    }
  }
}
