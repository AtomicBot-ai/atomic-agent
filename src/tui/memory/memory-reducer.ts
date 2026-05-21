import type { TuiState } from "../tui-state.js";
import {
  cycleMemoryChannel,
  cycleNotesArchiveFilter,
  selectVisibleMemoryRows,
} from "./memory-filter.js";
import { isMemoryAction, type MemoryAction } from "./memory-actions.js";
import type { MemoryPanelState } from "./memory-panel-state.js";

export function reduceMemoryAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isMemoryAction(action)) return null;
  const panel = state.memoryPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, memoryPanel: next };
}

function reducePanel(
  panel: MemoryPanelState,
  action: MemoryAction,
): MemoryPanelState {
  switch (action.type) {
    case "memory_refresh_started":
      return { ...panel, loading: true, lastError: null };
    case "memory_rows_loaded": {
      const nextPanel: MemoryPanelState = {
        ...panel,
        rows: action.rows,
        availableChannels: action.availableChannels,
        channelHint: action.channelHint,
        lastRefreshedAt: action.at,
        loading: false,
      };
      return {
        ...nextPanel,
        cursor: clampCursor(panel.cursor, visibleLength(nextPanel)),
      };
    }
    case "memory_refresh_failed":
      return { ...panel, loading: false, lastError: action.error };
    case "memory_cursor_moved": {
      const total = visibleLength(panel);
      return {
        ...panel,
        cursor: Math.max(0, Math.min(total - 1, panel.cursor + action.delta)),
      };
    }
    case "memory_cursor_set":
      return { ...panel, cursor: clampCursor(action.row, visibleLength(panel)) };
    case "memory_channel_cycled":
      return {
        ...panel,
        channel: cycleMemoryChannel(
          panel.channel,
          panel.availableChannels,
          action.direction,
        ),
        cursor: 0,
        mode: "list",
        detailRowKey: null,
        detail: null,
      };
    case "memory_channel_set":
      return {
        ...panel,
        channel: action.channel,
        cursor: 0,
        mode: "list",
        detailRowKey: null,
        detail: null,
      };
    case "memory_notes_filter_cycled":
      return {
        ...panel,
        notesArchiveFilter: cycleNotesArchiveFilter(
          panel.notesArchiveFilter,
          action.direction,
        ),
        cursor: 0,
      };
    case "memory_notes_filter_set":
      return { ...panel, notesArchiveFilter: action.filter, cursor: 0 };
    case "memory_search_set":
      return { ...panel, searchQuery: action.query, cursor: 0 };
    case "memory_auto_refresh_toggled":
      return { ...panel, autoRefresh: !panel.autoRefresh };
    case "memory_detail_opened":
      return {
        ...panel,
        mode: "detail",
        detailRowKey: action.rowKey,
        detail: action.detail,
      };
    case "memory_detail_neighbors_updated":
      return { ...panel, detail: action.detail };
    case "memory_detail_closed":
      return {
        ...panel,
        mode: "list",
        detailRowKey: null,
        detail: null,
      };
    case "memory_refresh_requested":
      return panel;
  }
}

function clampCursor(cursor: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, cursor));
}

function visibleLength(panel: MemoryPanelState): number {
  return selectVisibleMemoryRows(panel).length;
}
