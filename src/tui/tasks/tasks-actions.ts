import type {
  TaskCancelConfirmState,
  TaskCreateFocus,
  TaskCreateFormState,
  TaskCreateKind,
  TaskFiringEntry,
  TaskSummaryRow,
  TasksFilterStatus,
  TasksPanelMode,
} from "./tasks-panel-state.js";

/**
 * All reducer actions specific to the Tasks tab. Orchestrator- and
 * keyboard-layer code emit these; the reducer folds them into
 * `state.tasksPanel`. Kept in its own module so the root `TuiAction`
 * union stays under the 300-LOC budget.
 */
export type TasksAction =
  | { type: "tasks_refresh_started" }
  | {
      type: "tasks_refreshed";
      rows: readonly TaskSummaryRow[];
      at: number;
    }
  | { type: "tasks_refresh_failed"; error: string }
  | { type: "tasks_cursor_moved"; delta: 1 | -1 | number }
  | { type: "tasks_cursor_set"; row: number }
  | { type: "tasks_filter_cycled"; direction: 1 | -1 }
  | { type: "tasks_filter_set"; status: TasksFilterStatus }
  | { type: "tasks_auto_refresh_toggled" }
  | { type: "tasks_search_opened" }
  | { type: "tasks_search_query_changed"; query: string }
  | { type: "tasks_search_closed" }
  | { type: "tasks_mode_set"; mode: TasksPanelMode }
  | { type: "tasks_detail_opened"; taskId: string }
  | { type: "tasks_detail_closed" }
  | {
      type: "tasks_firing_observed";
      entry: TaskFiringEntry;
    }
  | { type: "tasks_create_form_opened"; kind?: TaskCreateKind }
  | { type: "tasks_create_form_closed" }
  | { type: "tasks_create_form_updated"; patch: Partial<TaskCreateFormState> }
  | { type: "tasks_create_focus_set"; focus: TaskCreateFocus }
  | { type: "tasks_create_submit_started" }
  | { type: "tasks_create_submit_settled"; error?: string }
  | {
      type: "tasks_cancel_confirm_opened";
      confirm: TaskCancelConfirmState;
    }
  | { type: "tasks_cancel_confirm_closed" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isTasksAction(action: { type: string }): action is TasksAction {
  return action.type.startsWith("tasks_");
}
