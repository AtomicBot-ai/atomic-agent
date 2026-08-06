import type {
  LlmHuggingFaceHit,
  LlmPanelMode,
  LlmPanelSection,
} from "./llm-panel-state.js";

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
  | { type: "llm_hf_prompt_opened" }
  | { type: "llm_hf_prompt_buffer_changed"; buffer: string }
  | { type: "llm_hf_prompt_busy_set"; busy: boolean }
  | { type: "llm_hf_prompt_failed"; error: string }
  | { type: "llm_hf_prompt_results_set"; results: readonly LlmHuggingFaceHit[] }
  | { type: "llm_hf_prompt_closed" };

const LLM_PANEL_ACTION_TYPES: ReadonlySet<string> = new Set([
  "llm_mode_set",
  "llm_mode_set_to_active_route",
  "llm_mode_toggled",
  "llm_cursor_set",
  "llm_focus_set",
  "llm_stop_local_daemons_prompt_opened",
  "llm_stop_local_daemons_prompt_closed",
  "llm_external_url_draft_set",
  "llm_hf_prompt_opened",
  "llm_hf_prompt_buffer_changed",
  "llm_hf_prompt_busy_set",
  "llm_hf_prompt_failed",
  "llm_hf_prompt_results_set",
  "llm_hf_prompt_closed",
]);

export function isLlmPanelAction(
  action: { type: string },
): action is LlmPanelAction {
  return LLM_PANEL_ACTION_TYPES.has(action.type);
}
