import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type {
  TaskFiringEntry,
  TaskSummaryRow,
  TasksPanelState,
} from "../tasks/tasks-panel-state.js";
import {
  formatIntervalMs,
  formatRelativeMs,
  formatUnixMs,
} from "../tasks/tasks-summary.js";

export interface TasksDetailProps {
  panel: TasksPanelState;
  now: number;
}

/**
 * Single-task card: schedule, counters, last error, and a compact feed
 * of recent firings. Shown when `panel.mode === "detail"`. The backing
 * record is looked up through `panel.rows` so the view re-renders
 * automatically on refresh.
 */
export function TasksDetail(props: TasksDetailProps): ReactElement {
  const { panel, now } = props;
  const row = panel.rows.find((r) => r.id === panel.detailTaskId);
  if (!row) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.warn}>
          task {panel.detailTaskId ?? "?"} not found in the current snapshot.
          Press Esc to return to the list.
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <HeaderBlock row={row} now={now} />
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>message:</Text>
      </Box>
      <Text>{row.userMessage}</Text>
      {row.lastError ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>last error: {row.lastError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>recent firings:</Text>
      </Box>
      <FiringsFeed firings={panel.detailFirings} />
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          o open session · R run-now · c cancel · Esc back
        </Text>
      </Box>
    </Box>
  );
}

function HeaderBlock({
  row,
  now,
}: {
  row: TaskSummaryRow;
  now: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.colors.accentSoft}>
        {row.id}
        <Text color={theme.colors.muted}>  ·  {row.origin}</Text>
      </Text>
      <Text>
        <Text color={theme.colors.muted}>status:</Text> {row.status}
        {"  "}
        <Text color={theme.colors.muted}>schedule:</Text> {row.scheduleLabel}
        {row.recurring ? " (recurring)" : ""}
      </Text>
      <Text>
        <Text color={theme.colors.muted}>next-run:</Text>{" "}
        {formatRelativeMs(row.scheduledFor, now)}{" "}
        <Text color={theme.colors.muted}>
          ({row.scheduledFor !== null ? formatUnixMs(row.scheduledFor) : "-"})
        </Text>
      </Text>
      <Text>
        <Text color={theme.colors.muted}>attempts:</Text>{" "}
        {row.attempts}/{row.maxAttempts}
        {"  "}
        <Text color={theme.colors.muted}>session:</Text>{" "}
        {row.sessionId ?? "—"}
      </Text>
      <Text color={theme.colors.muted}>
        created: {formatUnixMs(row.createdAt)} · updated:{" "}
        {formatUnixMs(row.updatedAt)}
        {row.completedAt !== null
          ? ` · completed: ${formatUnixMs(row.completedAt)}`
          : ""}
      </Text>
    </Box>
  );
}

function FiringsFeed({
  firings,
}: {
  firings: readonly TaskFiringEntry[];
}): ReactElement {
  if (firings.length === 0) {
    return (
      <Text color={theme.colors.muted}>
        (no firings yet — scheduler activity will appear here)
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {firings.map((entry) => (
        <FiringRow key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}

function FiringRow({ entry }: { entry: TaskFiringEntry }): ReactElement {
  const when = formatUnixMs(entry.startedAt);
  const reason = entry.reason ?? "running";
  const duration =
    entry.durationMs !== null ? ` · ${formatIntervalMs(entry.durationMs)}` : "";
  return (
    <Text color={theme.colors.muted}>
      {when} | {reason.padEnd(9)} | steps {entry.stepCount}
      {duration}
    </Text>
  );
}
