import type { ComposerSwitchKind } from "./composer-switch-state.js";

export type ComposerSwitchAction =
  /** Open (or move) the switch strip onto `kind`, cursor on the active row. */
  | { type: "composer_switch_opened"; kind: ComposerSwitchKind }
  | { type: "composer_switch_closed" }
  | { type: "composer_switch_cursor_moved"; delta: number }
  /** Put the cursor on an absolute row (mouse hover-then-click). */
  | { type: "composer_switch_cursor_set"; cursor: number }
  /** Replace the typed filter (append and backspace both land here). */
  | { type: "composer_switch_filter_set"; filter: string };

export function isComposerSwitchAction(action: {
  type: string;
}): action is ComposerSwitchAction {
  return (
    action.type === "composer_switch_opened" ||
    action.type === "composer_switch_closed" ||
    action.type === "composer_switch_cursor_moved" ||
    action.type === "composer_switch_cursor_set" ||
    action.type === "composer_switch_filter_set"
  );
}
