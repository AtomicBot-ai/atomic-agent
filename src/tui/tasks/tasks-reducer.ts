import type { TuiState } from "../tui-state.js";
import { cycleTasksFilter } from "./tasks-filter.js";
import {
  TASK_FIRINGS_RING_SIZE,
  createEmptyCreateForm,
  type TaskCreateFormState,
  type TasksPanelState,
} from "./tasks-panel-state.js";
import type { TasksAction } from "./tasks-actions.js";

/**
 * Reducer slice for `state.tasksPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through to other slices.
 *
 * The slice is intentionally small: everything non-trivial (validation,
 * filtering, record -> row conversion) lives in sibling pure modules so
 * the reducer stays obvious under a `switch`.
 */
export function reduceTasksAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isTasksAction(action)) return null;
  const panel = state.tasksPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, tasksPanel: next };
}

function isTasksAction(action: { type: string }): action is TasksAction {
  return action.type.startsWith("tasks_");
}

function reducePanel(
  panel: TasksPanelState,
  action: TasksAction,
): TasksPanelState {
  switch (action.type) {
    case "tasks_refresh_started":
      return { ...panel, loading: true };
    case "tasks_refreshed":
      return {
        ...panel,
        rows: action.rows,
        cursor: clampCursor(panel.cursor, action.rows.length),
        lastRefreshedAt: action.at,
        loading: false,
      };
    case "tasks_refresh_failed":
      return { ...panel, loading: false };
    case "tasks_cursor_moved": {
      const nextCursor = Math.max(
        0,
        Math.min(panel.rows.length - 1, panel.cursor + action.delta),
      );
      return { ...panel, cursor: nextCursor };
    }
    case "tasks_cursor_set":
      return { ...panel, cursor: clampCursor(action.row, panel.rows.length) };
    case "tasks_filter_cycled":
      return {
        ...panel,
        filterStatus: cycleTasksFilter(panel.filterStatus, action.direction),
        cursor: 0,
      };
    case "tasks_filter_set":
      return { ...panel, filterStatus: action.status, cursor: 0 };
    case "tasks_auto_refresh_toggled":
      return { ...panel, autoRefresh: !panel.autoRefresh };
    case "tasks_search_opened":
      return { ...panel, searchOpen: true };
    case "tasks_search_query_changed":
      return { ...panel, searchQuery: action.query, cursor: 0 };
    case "tasks_search_closed":
      return { ...panel, searchOpen: false, searchQuery: "" };
    case "tasks_mode_set":
      return { ...panel, mode: action.mode };
    case "tasks_detail_opened":
      return {
        ...panel,
        mode: "detail",
        detailTaskId: action.taskId,
        detailFirings: [],
      };
    case "tasks_detail_closed":
      return {
        ...panel,
        mode: "list",
        detailTaskId: null,
        detailFirings: [],
      };
    case "tasks_firing_observed": {
      if (panel.detailTaskId !== action.entry.taskId) return panel;
      const existingIdx = panel.detailFirings.findIndex(
        (entry) => entry.id === action.entry.id,
      );
      let firings = panel.detailFirings.slice();
      if (existingIdx >= 0) {
        firings[existingIdx] = action.entry;
      } else {
        firings.push(action.entry);
      }
      firings.sort((a, b) => b.startedAt - a.startedAt);
      if (firings.length > TASK_FIRINGS_RING_SIZE) {
        firings = firings.slice(0, TASK_FIRINGS_RING_SIZE);
      }
      return { ...panel, detailFirings: firings };
    }
    case "tasks_create_form_opened":
      return {
        ...panel,
        mode: "create",
        createForm: createEmptyCreateForm(action.kind),
      };
    case "tasks_create_form_closed":
      return { ...panel, mode: "list", createForm: null };
    case "tasks_create_form_updated": {
      if (!panel.createForm) return panel;
      const merged: TaskCreateFormState = { ...panel.createForm, ...action.patch };
      return { ...panel, createForm: merged };
    }
    case "tasks_create_focus_set":
      if (!panel.createForm) return panel;
      return {
        ...panel,
        createForm: { ...panel.createForm, focus: action.focus },
      };
    case "tasks_create_submit_started":
      if (!panel.createForm) return panel;
      return {
        ...panel,
        createForm: { ...panel.createForm, submitting: true },
      };
    case "tasks_create_submit_settled":
      if (!panel.createForm) return panel;
      if (!action.error) {
        return { ...panel, mode: "list", createForm: null };
      }
      return {
        ...panel,
        createForm: {
          ...panel.createForm,
          submitting: false,
          preview: {
            ok: false,
            error: action.error,
            nextFirings: panel.createForm.preview.nextFirings,
          },
        },
      };
    case "tasks_cancel_confirm_opened":
      return { ...panel, cancelConfirm: action.confirm };
    case "tasks_cancel_confirm_closed":
      return { ...panel, cancelConfirm: null };
    default:
      return panel;
  }
}

function clampCursor(cursor: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, cursor));
}
