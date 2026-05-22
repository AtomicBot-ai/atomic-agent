import type {
  MemoryChannel,
  MemoryDetailPayload,
  MemoryNotesArchiveFilter,
  MemorySummaryRow,
} from "./memory-panel-state.js";

/**
 * Actions that mutate `state.memoryPanel`. Names are prefixed with
 * `memory_` so the root reducer can delegate without collisions.
 */
export type MemoryAction =
  | {
      type: "memory_refresh_requested";
      channel: MemoryChannel;
      notesArchiveFilter: MemoryNotesArchiveFilter;
      searchQuery: string;
    }
  | { type: "memory_refresh_started" }
  | {
      type: "memory_rows_loaded";
      rows: readonly MemorySummaryRow[];
      availableChannels: readonly MemoryChannel[];
      channelHint: string | null;
      at: number;
    }
  | { type: "memory_refresh_failed"; error: string }
  | { type: "memory_cursor_moved"; delta: number }
  | { type: "memory_cursor_set"; row: number }
  | { type: "memory_channel_cycled"; direction: 1 | -1 }
  | { type: "memory_channel_set"; channel: MemoryChannel }
  | { type: "memory_notes_filter_cycled"; direction: 1 | -1 }
  | { type: "memory_notes_filter_set"; filter: MemoryNotesArchiveFilter }
  | { type: "memory_search_set"; query: string }
  | { type: "memory_auto_refresh_toggled" }
  | {
      type: "memory_detail_opened";
      rowKey: string;
      detail: MemoryDetailPayload;
    }
  | {
      type: "memory_detail_neighbors_updated";
      detail: MemoryDetailPayload;
    }
  | { type: "memory_detail_closed" };

export function isMemoryAction(action: {
  type: string;
}): action is MemoryAction {
  return action.type.startsWith("memory_");
}
