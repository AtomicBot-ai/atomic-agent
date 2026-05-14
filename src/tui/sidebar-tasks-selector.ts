import type { TaskSummaryRow } from "./tasks/tasks-panel-state.js";

/** Hard cap on how many tasks the sidebar surfaces. Keeps the rail dense. */
export const SIDEBAR_TASKS_LIMIT = 5;

/**
 * Status priority for sidebar ordering — running first (the operator
 * needs to see what is in flight), then queued, then everything else
 * by recency. We collapse `failed` / `blocked` / `cancelled` /
 * `completed` into a single bucket since the sidebar shows them only
 * when they are recurring (and therefore expected to fire again).
 */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  pending: 1,
  blocked: 2,
  failed: 3,
  cancelled: 4,
  completed: 5,
};

/**
 * Project the full `tasksPanel.rows` snapshot onto the compact sidebar
 * view: only **active or recurring** tasks are shown so the rail stays
 * actionable. The result is a stable slice — same `tasksPanel.rows`
 * input always yields the same row order — which lets the cursor
 * tracking in `TuiState.sidebarTasksCursor` stay coherent across
 * refreshes without the reducer having to inspect snapshot deltas.
 */
export function selectSidebarTasks(
  rows: readonly TaskSummaryRow[],
  limit: number = SIDEBAR_TASKS_LIMIT,
): TaskSummaryRow[] {
  const active = rows.filter(
    (row) =>
      row.status === "pending" ||
      row.status === "running" ||
      row.recurring,
  );
  const sorted = [...active].sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 99;
    const sb = STATUS_RANK[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return b.updatedAt - a.updatedAt;
  });
  return sorted.slice(0, limit);
}
