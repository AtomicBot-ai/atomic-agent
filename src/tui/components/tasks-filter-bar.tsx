import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type {
  TasksFilterStatus,
  TasksPanelState,
} from "../tasks/tasks-panel-state.js";

export interface TasksFilterBarProps {
  panel: TasksPanelState;
  visibleCount: number;
  totalCount: number;
  now: number;
}

/**
 * One-line bar above the task list: active filter / search / auto-
 * refresh state / visible-vs-total counts. Renders as a muted strip so
 * it does not compete visually with the table rows below.
 */
export function TasksFilterBar(props: TasksFilterBarProps): ReactElement {
  const { panel, visibleCount, totalCount, now } = props;
  const filterLabel = formatFilterLabel(panel.filterStatus);
  const refreshLabel = formatRefreshLabel(panel.lastRefreshedAt, panel.autoRefresh, now);
  return (
    <Box>
      <Text color={theme.colors.accentSoft} bold>
        Tasks
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}filter: {filterLabel}
        {"  "}·{"  "}
        {visibleCount}/{totalCount}
        {panel.searchQuery.length > 0
          ? `  ·  /${panel.searchQuery}`
          : panel.searchOpen
            ? "  ·  /_"
            : ""}
        {"  "}·{"  "}refresh: {refreshLabel}
        {panel.loading ? "  ·  loading…" : ""}
      </Text>
    </Box>
  );
}

function formatFilterLabel(status: TasksFilterStatus): string {
  return status;
}

function formatRefreshLabel(
  lastRefreshedAt: number | null,
  autoRefresh: boolean,
  now: number,
): string {
  const mode = autoRefresh ? "auto" : "manual";
  if (lastRefreshedAt === null) return `${mode} (never)`;
  const ageMs = Math.max(0, now - lastRefreshedAt);
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 1) return `${mode} (just now)`;
  if (seconds < 60) return `${mode} (${seconds}s ago)`;
  const minutes = Math.floor(seconds / 60);
  return `${mode} (${minutes}m ago)`;
}
