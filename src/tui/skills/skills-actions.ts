import type {
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
  | { type: "skills_error_set"; error: string | null };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isSkillsAction(action: { type: string }): action is SkillsAction {
  return action.type.startsWith("skills_");
}
