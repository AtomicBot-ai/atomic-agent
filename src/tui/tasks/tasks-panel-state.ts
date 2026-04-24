import type {
  TaskOrigin,
  TaskStatus,
  TriggerSource,
} from "../../tasks/task-types.js";

/**
 * Local UI state for the TUI "Tasks" tab. Lives alongside the rest of
 * `TuiState` and is folded by `tasks-reducer.ts` from a small set of
 * `tasks_*` actions emitted by the orchestrator and keyboard layer.
 *
 * The tab has three mutually exclusive modes:
 *
 *  - `list`   — scrollable table of recent tasks (the default).
 *  - `detail` — full card for one task + recent firings feed.
 *  - `create` — modal form for submitting a new scheduled task.
 *
 * Keeping the data model completely independent from `TaskRecord` lets
 * the reducer stay pure (no SQLite handle) and gives the orchestrator a
 * stable contract for wire events.
 */
export type TasksPanelMode = "list" | "detail" | "create";

/**
 * Filter buckets surfaced in the list-view header. `all` is the default,
 * `recurring` selects any task with `recurring === true` regardless of
 * its status; the remaining values mirror `TaskStatus` one-to-one.
 */
export type TasksFilterStatus =
  | "all"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "recurring";

/** Compact row shape rendered by `tasks-list.tsx`. */
export interface TaskSummaryRow {
  id: string;
  status: TaskStatus;
  origin: TaskOrigin;
  triggerSource: TriggerSource | null;
  sessionId: string | null;
  userMessage: string;
  scheduleKind: "at" | "cron" | "interval" | null;
  scheduleLabel: string;
  recurring: boolean;
  scheduledFor: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

/** Compact entry for the per-task firings feed on the detail screen. */
export interface TaskFiringEntry {
  id: string;
  taskId: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  reason: "reply" | "finish" | "cancelled" | "error" | "pending" | null;
  stepCount: number;
  durationMs: number | null;
}

/** Schedule kind selected inside the create form. */
export type TaskCreateKind = "cron" | "interval" | "at";

/**
 * All user input buffers for the create form plus a live preview/
 * validation block. Form submission is guarded by `preview.ok` — the
 * reducer never sends a submit action while validation fails.
 */
export interface TaskCreateFormState {
  kind: TaskCreateKind;
  cronExpression: string;
  intervalSeconds: string;
  atIsoOrMs: string;
  tz: string;
  message: string;
  /** Which field has keyboard focus inside the form. */
  focus: TaskCreateFocus;
  preview: TaskCreatePreview;
  submitting: boolean;
}

export type TaskCreateFocus =
  | "kind"
  | "expression"
  | "tz"
  | "message"
  | "submit";

/** Validator output. `ok=false` disables the submit button. */
export interface TaskCreatePreview {
  ok: boolean;
  error: string | null;
  /** Up to 5 Unix-ms firings computed from the current expression. */
  nextFirings: readonly number[];
}

/** Modal state for the cancel confirmation prompt. */
export interface TaskCancelConfirmState {
  taskId: string;
  isRecurring: boolean;
}

/** Root state slice for the Tasks tab. */
export interface TasksPanelState {
  mode: TasksPanelMode;
  rows: readonly TaskSummaryRow[];
  cursor: number;
  lastRefreshedAt: number | null;
  loading: boolean;
  autoRefresh: boolean;
  filterStatus: TasksFilterStatus;
  searchQuery: string;
  searchOpen: boolean;
  detailTaskId: string | null;
  detailFirings: readonly TaskFiringEntry[];
  createForm: TaskCreateFormState | null;
  cancelConfirm: TaskCancelConfirmState | null;
}

export function createInitialTasksPanelState(): TasksPanelState {
  return {
    mode: "list",
    rows: [],
    cursor: 0,
    lastRefreshedAt: null,
    loading: false,
    autoRefresh: true,
    filterStatus: "all",
    searchQuery: "",
    searchOpen: false,
    detailTaskId: null,
    detailFirings: [],
    createForm: null,
    cancelConfirm: null,
  };
}

export function createEmptyCreateForm(
  kind: TaskCreateKind = "cron",
): TaskCreateFormState {
  return {
    kind,
    cronExpression: kind === "cron" ? "0 * * * *" : "",
    intervalSeconds: kind === "interval" ? "300" : "",
    atIsoOrMs: "",
    tz: "",
    message: "",
    focus: "kind",
    preview: { ok: false, error: null, nextFirings: [] },
    submitting: false,
  };
}

/** Cycle order for the kind selector when the user presses ←/→ in the form. */
export const TASK_CREATE_KIND_ORDER: readonly TaskCreateKind[] = [
  "cron",
  "interval",
  "at",
];

/** Cycle order for keyboard Tab-navigation across the form fields. */
export const TASK_CREATE_FOCUS_ORDER: readonly TaskCreateFocus[] = [
  "kind",
  "expression",
  "tz",
  "message",
  "submit",
];

/** Max rows kept in the firings feed per detail view. */
export const TASK_FIRINGS_RING_SIZE = 10;
