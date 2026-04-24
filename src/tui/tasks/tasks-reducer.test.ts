import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { reduceTasksAction } from "./tasks-reducer.js";
import type { TaskSummaryRow } from "./tasks-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://localhost",
  browserChannel: "chromium",
  browserHeadless: true,
  approvalRequired: false,
  maxSteps: 10,
  skillCount: 0,
};

const ROW: TaskSummaryRow = {
  id: "t-1",
  status: "pending",
  origin: "tui",
  triggerSource: "user",
  sessionId: "s-1",
  userMessage: "hello",
  scheduleKind: "cron",
  scheduleLabel: "cron: 0 * * * *",
  recurring: true,
  scheduledFor: 1_000,
  createdAt: 500,
  updatedAt: 500,
  startedAt: null,
  completedAt: null,
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
};

describe("reduceTasksAction", () => {
  it("returns null for non-tasks actions so the root reducer can fall through", () => {
    const state = createInitialTuiState(SESSION);
    const result = reduceTasksAction(state, { type: "chat_cleared" });
    expect(result).toBeNull();
  });

  it("folds tasks_refreshed into rows + lastRefreshedAt", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceTasksAction(state, {
      type: "tasks_refreshed",
      rows: [ROW],
      at: 42,
    });
    expect(next).not.toBeNull();
    expect(next!.tasksPanel.rows).toHaveLength(1);
    expect(next!.tasksPanel.lastRefreshedAt).toBe(42);
    expect(next!.tasksPanel.loading).toBe(false);
  });

  it("clamps cursor_moved to the row range", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, {
      type: "tasks_refreshed",
      rows: [ROW, { ...ROW, id: "t-2" }],
      at: 0,
    })!;
    const moved = reduceTasksAction(state, {
      type: "tasks_cursor_moved",
      delta: 99,
    });
    expect(moved!.tasksPanel.cursor).toBe(1);
  });

  it("opens and closes the detail view", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, {
      type: "tasks_detail_opened",
      taskId: "t-1",
    })!;
    expect(state.tasksPanel.mode).toBe("detail");
    expect(state.tasksPanel.detailTaskId).toBe("t-1");
    const closed = reduceTasksAction(state, { type: "tasks_detail_closed" });
    expect(closed!.tasksPanel.mode).toBe("list");
    expect(closed!.tasksPanel.detailTaskId).toBeNull();
  });

  it("opens the create form and closes it on submit success", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, { type: "tasks_create_form_opened" })!;
    expect(state.tasksPanel.mode).toBe("create");
    expect(state.tasksPanel.createForm).not.toBeNull();
    state = reduceTasksAction(state, {
      type: "tasks_create_submit_started",
    })!;
    expect(state.tasksPanel.createForm!.submitting).toBe(true);
    state = reduceTasksAction(state, { type: "tasks_create_submit_settled" })!;
    expect(state.tasksPanel.mode).toBe("list");
    expect(state.tasksPanel.createForm).toBeNull();
  });

  it("keeps the form open with an error on submit failure", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, { type: "tasks_create_form_opened" })!;
    state = reduceTasksAction(state, {
      type: "tasks_create_submit_settled",
      error: "boom",
    })!;
    expect(state.tasksPanel.mode).toBe("create");
    expect(state.tasksPanel.createForm!.preview.error).toBe("boom");
  });

  it("tracks firing entries for the open detail task", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, {
      type: "tasks_detail_opened",
      taskId: "t-1",
    })!;
    state = reduceTasksAction(state, {
      type: "tasks_firing_observed",
      entry: {
        id: "t-1:1000",
        taskId: "t-1",
        sessionId: "s-1",
        startedAt: 1_000,
        finishedAt: 2_000,
        reason: "finish",
        stepCount: 1,
        durationMs: 1_000,
      },
    })!;
    expect(state.tasksPanel.detailFirings).toHaveLength(1);
    // firings for other tasks are dropped
    state = reduceTasksAction(state, {
      type: "tasks_firing_observed",
      entry: {
        id: "t-2:1000",
        taskId: "t-2",
        sessionId: "s-2",
        startedAt: 1_000,
        finishedAt: 2_000,
        reason: "finish",
        stepCount: 1,
        durationMs: 1_000,
      },
    })!;
    expect(state.tasksPanel.detailFirings).toHaveLength(1);
  });

  it("toggles auto-refresh and filter cycling", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.tasksPanel.autoRefresh).toBe(true);
    state = reduceTasksAction(state, { type: "tasks_auto_refresh_toggled" })!;
    expect(state.tasksPanel.autoRefresh).toBe(false);
    state = reduceTasksAction(state, {
      type: "tasks_filter_cycled",
      direction: 1,
    })!;
    expect(state.tasksPanel.filterStatus).toBe("pending");
  });

  it("opens and dismisses the cancel-confirm modal", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTasksAction(state, {
      type: "tasks_cancel_confirm_opened",
      confirm: { taskId: "t-1", isRecurring: true },
    })!;
    expect(state.tasksPanel.cancelConfirm).toEqual({
      taskId: "t-1",
      isRecurring: true,
    });
    state = reduceTasksAction(state, { type: "tasks_cancel_confirm_closed" })!;
    expect(state.tasksPanel.cancelConfirm).toBeNull();
  });
});
