import type {
  HubCardState,
  HubSkillRow,
  SkillInstallConfirmState,
  SkillRemoveConfirmState,
  SkillSummaryRow,
  SkillsFilterStatus,
} from "./skills-panel-state.js";

/**
 * All reducer actions specific to the Skills tab. The orchestrator and
 * the keyboard layer emit these; the reducer folds them into
 * `state.skillsPanel`. Action names are prefixed with `skills_` so the
 * root reducer can dispatch by simple prefix check.
 */
export type SkillsAction =
  | { type: "skills_refresh_started" }
  | {
      type: "skills_refreshed";
      rows: readonly SkillSummaryRow[];
      at: number;
    }
  | { type: "skills_refresh_failed"; error: string }
  | { type: "skills_cursor_moved"; delta: 1 | -1 | number }
  | { type: "skills_cursor_set"; row: number }
  | { type: "skills_filter_cycled"; direction: 1 | -1 }
  | { type: "skills_filter_set"; status: SkillsFilterStatus }
  | { type: "skills_auto_refresh_toggled" }
  | { type: "skills_detail_opened"; name: string; body: string }
  | { type: "skills_detail_closed" }
  | { type: "skills_toggle_settled"; name: string; disabled: boolean }
  | { type: "skills_error_set"; error: string | null }
  // --- hub ---
  | { type: "skills_hub_opened" }
  | { type: "skills_hub_closed" }
  | { type: "skills_hub_loading"; loading: boolean }
  | {
      type: "skills_hub_results";
      rows: readonly HubSkillRow[];
      error: string | null;
    }
  | { type: "skills_hub_cursor_moved"; delta: 1 | -1 | number }
  /** Put the Skills Hub cursor on an absolute row (mouse click). */
  | { type: "skills_hub_cursor_set"; row: number }
  | { type: "skills_hub_search_focus"; editing: boolean }
  | { type: "skills_hub_query_changed"; query: string }
  | { type: "skills_install_loading"; loading: boolean }
  | { type: "skills_install_failed"; error: string }
  | {
      type: "skills_install_confirm_opened";
      confirm: SkillInstallConfirmState;
    }
  | { type: "skills_install_confirm_closed" }
  | { type: "skills_hub_card_loading"; loading: boolean }
  | { type: "skills_hub_card_opened"; card: HubCardState }
  | { type: "skills_hub_card_closed" }
  | { type: "skills_hub_card_scrolled"; delta: number }
  | { type: "skills_remove_confirm_opened"; confirm: SkillRemoveConfirmState }
  | { type: "skills_remove_confirm_closed" }
  | { type: "skills_remove_submitting" }
  | { type: "skills_remove_failed"; error: string };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isSkillsAction(action: { type: string }): action is SkillsAction {
  return action.type.startsWith("skills_");
}
