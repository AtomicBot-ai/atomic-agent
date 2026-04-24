import type {
  TaskSummaryRow,
  TasksFilterStatus,
  TasksPanelState,
} from "./tasks-panel-state.js";

/**
 * Pure filter applied to the in-memory task snapshot before it reaches
 * the list component. Keeps ordering deterministic: unscheduled (null
 * `scheduledFor`) go first, then ascending by `scheduledFor`, then
 * descending by `createdAt` as a tiebreaker. Mirrors the SQL ordering
 * used by `TaskStore.list` so the cursor position stays stable across
 * refreshes.
 */
export interface TasksFilter {
  status: TasksFilterStatus;
  search: string;
}

export function filterAndSortTaskRows(
  rows: readonly TaskSummaryRow[],
  filter: TasksFilter,
): TaskSummaryRow[] {
  const needle = filter.search.trim().toLowerCase();
  const matched = rows.filter((row) => matchesFilter(row, filter.status, needle));
  return matched.slice().sort(compareTaskRows);
}

function matchesFilter(
  row: TaskSummaryRow,
  status: TasksFilterStatus,
  needle: string,
): boolean {
  if (!matchesStatus(row, status)) return false;
  if (needle.length === 0) return true;
  return (
    row.userMessage.toLowerCase().includes(needle) ||
    row.id.toLowerCase().includes(needle) ||
    (row.sessionId !== null && row.sessionId.toLowerCase().includes(needle))
  );
}

function matchesStatus(row: TaskSummaryRow, status: TasksFilterStatus): boolean {
  switch (status) {
    case "all":
      return true;
    case "recurring":
      return row.recurring;
    default:
      return row.status === status;
  }
}

function compareTaskRows(a: TaskSummaryRow, b: TaskSummaryRow): number {
  const aDue = a.scheduledFor ?? Number.POSITIVE_INFINITY;
  const bDue = b.scheduledFor ?? Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  return b.createdAt - a.createdAt;
}

/**
 * Cycle through the filter buckets in the order used by `f` keypress.
 * Keeps `recurring` at the tail so operators land on the most-common
 * filters first.
 */
const FILTER_ORDER: readonly TasksFilterStatus[] = [
  "all",
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "recurring",
];

export function cycleTasksFilter(
  current: TasksFilterStatus,
  direction: 1 | -1 = 1,
): TasksFilterStatus {
  const idx = FILTER_ORDER.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + FILTER_ORDER.length) % FILTER_ORDER.length;
  return FILTER_ORDER[next] ?? "all";
}

export function listTasksFilterOrder(): readonly TasksFilterStatus[] {
  return FILTER_ORDER;
}

/**
 * Single source of truth for the filtered+sorted row slice used by the
 * list component, the keyboard layer and the reducer. Centralising the
 * selector ensures cursor clamping, Enter/c/R resolution and visual
 * chevron position all operate on the exact same row order.
 */
export function selectVisibleTaskRows(
  panel: Pick<TasksPanelState, "rows" | "filterStatus" | "searchQuery">,
): TaskSummaryRow[] {
  return filterAndSortTaskRows(panel.rows, {
    status: panel.filterStatus,
    search: panel.searchQuery,
  });
}
