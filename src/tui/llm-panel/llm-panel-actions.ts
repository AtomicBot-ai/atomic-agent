import type { LlmPanelMode, LlmPanelSection } from "./llm-panel-state.js";

export type LlmPanelAction =
  | { type: "llm_mode_set"; mode: LlmPanelMode }
  | { type: "llm_mode_set_to_active_route" }
  | { type: "llm_mode_toggled" }
  | { type: "llm_cursor_set"; cursor: number; mode?: LlmPanelMode }
  | { type: "llm_focus_set"; focus: LlmPanelSection; cursor?: number }
  | { type: "llm_stop_local_daemons_prompt_opened"; providerId: string }
  | { type: "llm_stop_local_daemons_prompt_closed" }
  /** Opens (string), edits (string) or closes (`null`) the external URL editor. */
  | { type: "llm_external_url_draft_set"; value: string | null }
  /** Focus/unfocus the Cloud pane's inline `filter:` row. */
  | { type: "llm_cloud_filter_focus_set"; focused: boolean }
  /** Replace the inline filter text (cursor snaps to the top of the result set). */
  | { type: "llm_cloud_filter_set"; value: string }
  /** Cycle the inline list's price facet: all → free → paid → all. */
  | { type: "llm_cloud_pricing_cycled" };

export function isLlmPanelAction(
  action: { type: string },
): action is LlmPanelAction {
  return (
    action.type === "llm_mode_set" ||
    action.type === "llm_mode_set_to_active_route" ||
    action.type === "llm_mode_toggled" ||
    action.type === "llm_cursor_set" ||
    action.type === "llm_focus_set" ||
    action.type === "llm_stop_local_daemons_prompt_opened" ||
    action.type === "llm_stop_local_daemons_prompt_closed" ||
    action.type === "llm_external_url_draft_set" ||
    action.type === "llm_cloud_filter_focus_set" ||
    action.type === "llm_cloud_filter_set" ||
    action.type === "llm_cloud_pricing_cycled"
  );
}
