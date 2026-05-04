import type { TuiState } from "../tui-state.js";
import { cycleSkillsFilter, selectVisibleSkillRows } from "./skills-filter.js";
import type { SkillsPanelState } from "./skills-panel-state.js";
import { isSkillsAction, type SkillsAction } from "./skills-actions.js";

/**
 * Reducer slice for `state.skillsPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through to other slices.
 *
 * The slice is intentionally small: filtering and record-to-row
 * conversion live in sibling pure modules so the reducer stays obvious
 * under a `switch`.
 */
export function reduceSkillsAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isSkillsAction(action)) return null;
  const panel = state.skillsPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, skillsPanel: next };
}

function reducePanel(
  panel: SkillsPanelState,
  action: SkillsAction,
): SkillsPanelState {
  switch (action.type) {
    case "skills_refresh_started":
      return { ...panel, loading: true, lastError: null };
    case "skills_refreshed": {
      const nextPanel: SkillsPanelState = { ...panel, rows: action.rows };
      return {
        ...nextPanel,
        cursor: clampCursor(panel.cursor, visibleLength(nextPanel)),
        lastRefreshedAt: action.at,
        loading: false,
      };
    }
    case "skills_refresh_failed":
      return { ...panel, loading: false, lastError: action.error };
    case "skills_cursor_moved": {
      const total = visibleLength(panel);
      const nextCursor = Math.max(
        0,
        Math.min(total - 1, panel.cursor + action.delta),
      );
      return { ...panel, cursor: nextCursor };
    }
    case "skills_cursor_set":
      return { ...panel, cursor: clampCursor(action.row, visibleLength(panel)) };
    case "skills_filter_cycled":
      return {
        ...panel,
        filterStatus: cycleSkillsFilter(panel.filterStatus, action.direction),
        cursor: 0,
      };
    case "skills_filter_set":
      return { ...panel, filterStatus: action.status, cursor: 0 };
    case "skills_auto_refresh_toggled":
      return { ...panel, autoRefresh: !panel.autoRefresh };
    case "skills_detail_opened":
      return {
        ...panel,
        mode: "detail",
        detailName: action.name,
        detailBody: action.body,
      };
    case "skills_detail_closed":
      return {
        ...panel,
        mode: "list",
        detailName: null,
        detailBody: null,
      };
    case "skills_toggle_settled": {
      // Optimistic update of the matching row's `disabled` flag — the
      // orchestrator follows up with a full `skills_refreshed` after
      // `runtime.refreshSkills` settles, but flipping the bit here
      // makes the UI feel instant.
      const rows = panel.rows.map((row) =>
        row.name === action.name ? { ...row, disabled: action.disabled } : row,
      );
      return { ...panel, rows };
    }
    case "skills_error_set":
      return { ...panel, lastError: action.error };
  }
}

function clampCursor(cursor: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, cursor));
}

function visibleLength(panel: SkillsPanelState): number {
  return selectVisibleSkillRows(panel).length;
}
