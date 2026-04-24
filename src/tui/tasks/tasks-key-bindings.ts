import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  TASK_CREATE_FOCUS_ORDER,
  TASK_CREATE_KIND_ORDER,
  type TaskCreateFocus,
  type TaskCreateFormState,
} from "./tasks-panel-state.js";
import { focusAfter } from "../components/tasks-create-form.js";
import { validateCreateForm } from "./tasks-form-validator.js";

export interface TasksTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Tasks tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true` when
 * the key was consumed so the caller can suppress the editor echo.
 *
 * The layer is split three ways:
 *
 *  - cancel-confirm modal intercepts everything (y/n/Esc).
 *  - create-form routes every keystroke into the focused field buffer
 *    and handles Tab/Shift+Tab, Ctrl+Enter, Esc, Left/Right.
 *  - list/detail modes use single-char hotkeys (j/k, n, c, R, r, a, f,
 *    /, o, Enter, Esc).
 */
export function handleTasksTabKey(
  input: string,
  key: Key,
  ctx: TasksTabKeyContext,
): boolean {
  const { state } = ctx;
  const panel = state.tasksPanel;
  if (state.uiMode !== "debug" || state.activeTab !== "tasks") return false;
  if (panel.cancelConfirm) return handleCancelConfirmKey(input, key, ctx);
  if (panel.mode === "create" && panel.createForm) {
    return handleCreateFormKey(input, key, ctx, panel.createForm);
  }
  if (panel.mode === "detail") return handleDetailKey(input, key, ctx);
  return handleListKey(input, key, ctx);
}

function handleCancelConfirmKey(
  input: string,
  key: Key,
  ctx: TasksTabKeyContext,
): boolean {
  const { dispatch, callbacks, state } = ctx;
  const confirm = state.tasksPanel.cancelConfirm!;
  const lower = input.toLowerCase();
  if (lower === "y") {
    callbacks.onTaskCancelConfirmed?.(confirm.taskId);
    return true;
  }
  if (lower === "n" || key.escape) {
    dispatch({ type: "tasks_cancel_confirm_closed" });
    return true;
  }
  return true;
}

function handleListKey(
  input: string,
  key: Key,
  ctx: TasksTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const panel = state.tasksPanel;
  if (key.downArrow || input === "j") {
    dispatch({ type: "tasks_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "tasks_cursor_moved", delta: -1 });
    return true;
  }
  if (key.return) {
    const row = panel.rows[panel.cursor];
    if (row) {
      callbacks.onTaskDetailRequested?.(row.id);
    }
    return true;
  }
  if (input === "n") {
    dispatch({ type: "tasks_create_form_opened" });
    return true;
  }
  if (input === "c") {
    const row = panel.rows[panel.cursor];
    if (!row) return true;
    if (row.recurring) {
      dispatch({
        type: "tasks_cancel_confirm_opened",
        confirm: { taskId: row.id, isRecurring: true },
      });
    } else {
      callbacks.onTaskCancelConfirmed?.(row.id);
    }
    return true;
  }
  if (input === "R") {
    const row = panel.rows[panel.cursor];
    if (row) callbacks.onTaskRunNowRequested?.(row.id);
    return true;
  }
  if (input === "r") {
    callbacks.onTasksRefreshRequested?.();
    return true;
  }
  if (input === "a") {
    dispatch({ type: "tasks_auto_refresh_toggled" });
    return true;
  }
  if (input === "f") {
    dispatch({ type: "tasks_filter_cycled", direction: 1 });
    return true;
  }
  return false;
}

function handleDetailKey(
  input: string,
  key: Key,
  ctx: TasksTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const detailId = state.tasksPanel.detailTaskId;
  if (key.escape) {
    dispatch({ type: "tasks_detail_closed" });
    return true;
  }
  if (!detailId) return key.escape ? true : false;
  if (input === "o") {
    callbacks.onTaskOpenSessionRequested?.(detailId);
    return true;
  }
  if (input === "R") {
    callbacks.onTaskRunNowRequested?.(detailId);
    return true;
  }
  if (input === "c") {
    const record = state.tasksPanel.rows.find((r) => r.id === detailId);
    if (record?.recurring) {
      dispatch({
        type: "tasks_cancel_confirm_opened",
        confirm: { taskId: detailId, isRecurring: true },
      });
    } else {
      callbacks.onTaskCancelConfirmed?.(detailId);
    }
    return true;
  }
  if (input === "r") {
    callbacks.onTasksRefreshRequested?.();
    return true;
  }
  return false;
}

function handleCreateFormKey(
  input: string,
  key: Key,
  ctx: TasksTabKeyContext,
  form: TaskCreateFormState,
): boolean {
  const { dispatch, callbacks } = ctx;
  if (key.escape) {
    dispatch({ type: "tasks_create_form_closed" });
    return true;
  }
  if (key.tab) {
    const next = focusAfter(
      form,
      key.shift ? -1 : 1,
      TASK_CREATE_FOCUS_ORDER,
    );
    dispatch({ type: "tasks_create_focus_set", focus: next });
    return true;
  }
  if (key.return && key.ctrl) {
    submitForm(form, dispatch, callbacks);
    return true;
  }
  if (key.return) {
    if (form.focus === "submit") {
      submitForm(form, dispatch, callbacks);
    } else {
      const next = focusAfter(form, 1, TASK_CREATE_FOCUS_ORDER);
      dispatch({ type: "tasks_create_focus_set", focus: next });
    }
    return true;
  }
  if (form.focus === "kind") {
    if (key.leftArrow) {
      cycleKind(form, -1, dispatch);
      return true;
    }
    if (key.rightArrow) {
      cycleKind(form, 1, dispatch);
      return true;
    }
  }
  if (key.backspace || key.delete) {
    return applyTextEdit(form, "", true, dispatch);
  }
  if (input && input.length > 0 && !key.ctrl && !key.meta) {
    return applyTextEdit(form, input, false, dispatch);
  }
  return false;
}

function submitForm(
  form: TaskCreateFormState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  const validation = validateCreateForm(form, Date.now());
  if (!validation.schedule) {
    dispatch({
      type: "tasks_create_form_updated",
      patch: {
        preview: validation.preview,
      },
    });
    return;
  }
  callbacks.onTaskCreateSubmitted?.({
    schedule: validation.schedule,
    message: validation.message,
    kind: form.kind,
  });
}

function cycleKind(
  form: TaskCreateFormState,
  direction: 1 | -1,
  dispatch: (action: TuiAction) => void,
): void {
  const idx = TASK_CREATE_KIND_ORDER.indexOf(form.kind);
  const safe = idx === -1 ? 0 : idx;
  const next =
    TASK_CREATE_KIND_ORDER[
      (safe + direction + TASK_CREATE_KIND_ORDER.length) %
        TASK_CREATE_KIND_ORDER.length
    ] ?? "cron";
  dispatch({
    type: "tasks_create_form_updated",
    patch: { kind: next },
  });
  revalidateForm({ ...form, kind: next }, dispatch);
}

function applyTextEdit(
  form: TaskCreateFormState,
  text: string,
  isBackspace: boolean,
  dispatch: (action: TuiAction) => void,
): boolean {
  const field = fieldForFocus(form.focus, form);
  if (!field) return false;
  const current = form[field];
  const next = isBackspace ? current.slice(0, -1) : current + text;
  const patch: Partial<TaskCreateFormState> = { [field]: next } as Partial<TaskCreateFormState>;
  dispatch({ type: "tasks_create_form_updated", patch });
  revalidateForm({ ...form, [field]: next } as TaskCreateFormState, dispatch);
  return true;
}

type TextFieldKey =
  | "cronExpression"
  | "intervalSeconds"
  | "atIsoOrMs"
  | "tz"
  | "message";

function fieldForFocus(
  focus: TaskCreateFocus,
  form: TaskCreateFormState,
): TextFieldKey | null {
  if (focus === "tz") return "tz";
  if (focus === "message") return "message";
  if (focus === "expression") {
    if (form.kind === "cron") return "cronExpression";
    if (form.kind === "interval") return "intervalSeconds";
    return "atIsoOrMs";
  }
  return null;
}

function revalidateForm(
  form: TaskCreateFormState,
  dispatch: (action: TuiAction) => void,
): void {
  const validation = validateCreateForm(form, Date.now());
  dispatch({
    type: "tasks_create_form_updated",
    patch: { preview: validation.preview },
  });
}
