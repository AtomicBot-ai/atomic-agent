import { Box } from "ink";
import { useMemo } from "react";
import type { ReactElement } from "react";
import type { TasksPanelState } from "../tasks/tasks-panel-state.js";
import {
  filterAndSortTaskRows,
  type TasksFilter,
} from "../tasks/tasks-filter.js";
import { TasksFilterBar } from "./tasks-filter-bar.js";
import { TasksList } from "./tasks-list.js";
import { TasksDetail } from "./tasks-detail.js";
import { TasksCreateForm } from "./tasks-create-form.js";

export interface TasksPanelProps {
  panel: TasksPanelState;
  now: number;
  maxRows?: number;
}

/**
 * Top-level router for the Tasks tab. Switches between list, detail
 * and create-form views based on `panel.mode`. The cancel-confirm
 * modal is rendered separately by `TuiApp` above the editor, not
 * inside the panel, so it never shifts the table layout.
 */
export function TasksPanel(props: TasksPanelProps): ReactElement {
  const { panel, now, maxRows = 14 } = props;
  const filter = useMemo<TasksFilter>(
    () => ({ status: panel.filterStatus, search: panel.searchQuery }),
    [panel.filterStatus, panel.searchQuery],
  );
  const visibleRows = useMemo(
    () => filterAndSortTaskRows(panel.rows, filter),
    [panel.rows, filter],
  );
  return (
    <Box flexDirection="column">
      <TasksFilterBar
        panel={panel}
        visibleCount={visibleRows.length}
        totalCount={panel.rows.length}
        now={now}
      />
      {panel.mode === "list" ? (
        <TasksList
          panel={panel}
          visibleRows={visibleRows}
          maxRows={maxRows}
          now={now}
        />
      ) : null}
      {panel.mode === "detail" ? (
        <TasksDetail panel={panel} now={now} />
      ) : null}
      {panel.mode === "create" && panel.createForm ? (
        <TasksCreateForm form={panel.createForm} />
      ) : null}
    </Box>
  );
}
