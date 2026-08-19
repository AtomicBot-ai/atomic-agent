import { Box } from "ink";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { computeChatWidth } from "../layout.js";
import type { TasksPanelState } from "../tasks/tasks-panel-state.js";
import { selectVisibleTaskRows } from "../tasks/tasks-filter.js";
import { TasksFilterBar } from "./tasks-filter-bar.js";
import { TasksList } from "./tasks-list.js";
import { TasksDetail } from "./tasks-detail.js";
import { TasksCreateForm } from "./tasks-create-form.js";

export interface TasksPanelProps {
  panel: TasksPanelState;
  now: number;
  maxRows?: number;
  /**
   * Columns the panel may draw into. Defaults to the live chat-column
   * width; tests pass it explicitly to pin a size.
   */
  width?: number;
}

/**
 * Rows the panel spends on its own chrome before the table starts: the
 * one-line filter bar. `maxRows` is the budget for everything the tab
 * draws, so the table below only ever gets what is left.
 */
const FILTER_BAR_ROWS = 1;

/**
 * Top-level router for the Tasks tab. Switches between list, detail
 * and create-form views based on `panel.mode`. The cancel-confirm
 * modal is rendered separately by `TuiApp` above the editor, not
 * inside the panel, so it never shifts the table layout.
 *
 * The panel measures itself: the debug pane hands down a row budget but
 * not a width, and the table below needs one, because the left rail
 * takes a quarter of the terminal away from every panel (see
 * `../layout.ts`). Deriving it here keeps the wiring inside the Tasks
 * tab rather than threading another prop through the shared pane.
 */
export function TasksPanel(props: TasksPanelProps): ReactElement {
  const terminal = useTerminalSize();
  const { panel, now, maxRows = 14 } = props;
  const width = props.width ?? computeChatWidth(terminal.columns);
  const visibleRows = useMemo(
    () => selectVisibleTaskRows(panel),
    [panel.rows, panel.filterStatus, panel.searchQuery],
  );
  return (
    <Box flexDirection="column" width={width}>
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
          maxRows={maxRows - FILTER_BAR_ROWS}
          now={now}
          width={width}
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
