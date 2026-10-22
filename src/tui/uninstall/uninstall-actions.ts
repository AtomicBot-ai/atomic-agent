import type { UninstallPreview } from "./uninstall-state.js";

export type UninstallAction =
  /** `/uninstall`, or the menu's last entry. Opens on the loading step. */
  | { type: "uninstall_opened" }
  | { type: "uninstall_plan_loaded"; preview: UninstallPreview }
  | { type: "uninstall_plan_failed"; error: string }
  | { type: "uninstall_cursor_set"; cursor: "continue" | "cancel" }
  /** `review` → `confirm`. Never skips a step; there is no jump action. */
  | { type: "uninstall_review_accepted" }
  | { type: "uninstall_typed_set"; typed: string }
  /**
   * The word checked out and the plan deletes a folder the desktop app
   * uses: `confirm` → `desktop`, the separate question about its data.
   */
  | { type: "uninstall_desktop_asked" }
  | { type: "uninstall_desktop_cursor_set"; cursor: "keep" | "delete" }
  /**
   * The word checked out (and, when the desktop shares the folder, the
   * `desktop` question was answered). Moves to `closing`; the caller then asks the
   * app to quit, and the removal happens after the unmount.
   */
  | { type: "uninstall_started" }
  | { type: "uninstall_closed" };

const UNINSTALL_ACTION_TYPES = new Set<string>([
  "uninstall_opened",
  "uninstall_plan_loaded",
  "uninstall_plan_failed",
  "uninstall_cursor_set",
  "uninstall_review_accepted",
  "uninstall_typed_set",
  "uninstall_desktop_asked",
  "uninstall_desktop_cursor_set",
  "uninstall_started",
  "uninstall_closed",
]);

export function isUninstallAction(action: {
  type: string;
}): action is UninstallAction {
  return UNINSTALL_ACTION_TYPES.has(action.type);
}
