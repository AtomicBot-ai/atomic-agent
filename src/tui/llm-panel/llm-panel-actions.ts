import type { LlmPanelMode, LlmPanelSection } from "./llm-panel-state.js";

export type LlmPanelAction =
  | { type: "llm_mode_set"; mode: LlmPanelMode }
  | { type: "llm_mode_set_to_active_route" }
  | { type: "llm_mode_toggled" }
  | { type: "llm_cursor_set"; cursor: number; mode?: LlmPanelMode }
  | { type: "llm_focus_set"; focus: LlmPanelSection; cursor?: number }
  | { type: "llm_stop_local_daemons_prompt_opened"; providerId: string }
  | { type: "llm_stop_local_daemons_prompt_closed" };

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
    action.type === "llm_stop_local_daemons_prompt_closed"
  );
}
