import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  cycleMemoryChannel,
  cycleNotesArchiveFilter,
  selectVisibleMemoryRows,
} from "./memory-filter.js";
import type { MemoryPanelState, MemorySummaryRow } from "./memory-panel-state.js";

export interface MemoryTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

export function handleMemoryTabKey(
  input: string,
  key: Key,
  ctx: MemoryTabKeyContext,
): boolean {
  const { state } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "memory") return false;
  const panel = state.memoryPanel;
  if (panel.mode === "detail") return handleDetailKey(input, key, ctx);
  return handleListKey(input, key, ctx);
}

function handleListKey(
  input: string,
  key: Key,
  ctx: MemoryTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const panel = state.memoryPanel;
  if (key.downArrow || input === "j") {
    dispatch({ type: "memory_cursor_moved", delta: 1 });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "memory_cursor_moved", delta: -1 });
    return true;
  }
  const selected = selectedVisibleRow(panel);
  if (key.return && selected) {
    if (selected.channel === "links" && selected.linkFromId !== undefined) {
      callbacks.onMemoryOpenNoteRequested?.(selected.linkFromId);
      return true;
    }
    callbacks.onMemoryDetailRequested?.(selected);
    return true;
  }
  if (input === "r") {
    dispatchRefresh(panel, dispatch);
    return true;
  }
  if (input === "a") {
    dispatch({ type: "memory_auto_refresh_toggled" });
    return true;
  }
  if (input === "f" && panel.channel === "notes") {
    const next = cycleNotesArchiveFilter(panel.notesArchiveFilter, 1);
    dispatch({ type: "memory_notes_filter_set", filter: next });
    dispatchRefresh({ ...panel, notesArchiveFilter: next }, dispatch);
    return true;
  }
  if (input === "[") {
    const next = cycleMemoryChannel(
      panel.channel,
      panel.availableChannels,
      -1,
    );
    dispatch({ type: "memory_channel_set", channel: next });
    dispatchRefresh({ ...panel, channel: next }, dispatch);
    return true;
  }
  if (input === "]") {
    const next = cycleMemoryChannel(
      panel.channel,
      panel.availableChannels,
      1,
    );
    dispatch({ type: "memory_channel_set", channel: next });
    dispatchRefresh({ ...panel, channel: next }, dispatch);
    return true;
  }
  if (input >= "1" && input <= "6") {
    const idx = Number(input) - 1;
    const ch = panel.availableChannels[idx];
    if (!ch) return false;
    dispatch({ type: "memory_channel_set", channel: ch });
    dispatchRefresh({ ...panel, channel: ch }, dispatch);
    return true;
  }
  return false;
}

function handleDetailKey(
  input: string,
  key: Key,
  ctx: MemoryTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const detail = state.memoryPanel.detail;
  if (key.escape) {
    dispatch({ type: "memory_detail_closed" });
    return true;
  }
  if (input === "g" && detail?.channel === "notes") {
    callbacks.onMemoryExpandNeighborsRequested?.(detail.id);
    return true;
  }
  if (input === "r") {
    dispatchRefresh(state.memoryPanel, dispatch);
    return true;
  }
  if (key.return && detail?.channel === "notes") {
    const panel = state.memoryPanel;
    const neighbor = pickLinkNeighbor(panel, state.memoryPanel.cursor);
    if (neighbor !== null) {
      callbacks.onMemoryOpenNoteRequested?.(neighbor);
      return true;
    }
  }
  return false;
}

function pickLinkNeighbor(
  panel: MemoryPanelState,
  cursor: number,
): number | null {
  if (panel.detail?.channel !== "notes") return null;
  const all = [
    ...panel.detail.outgoing.map((n) => n.memoryId),
    ...panel.detail.incoming.map((n) => n.memoryId),
    ...panel.detail.expandedNeighbors,
  ];
  if (all.length === 0) return null;
  const idx = Math.max(0, Math.min(cursor, all.length - 1));
  return all[idx] ?? null;
}

function dispatchRefresh(
  panel: MemoryPanelState,
  dispatch: (action: TuiAction) => void,
): void {
  dispatch({
    type: "memory_refresh_requested",
    channel: panel.channel,
    notesArchiveFilter: panel.notesArchiveFilter,
    searchQuery: panel.searchQuery,
  });
}

function selectedVisibleRow(
  panel: MemoryPanelState,
): MemorySummaryRow | null {
  const visible = selectVisibleMemoryRows(panel);
  if (visible.length === 0) return null;
  const clamped = Math.max(0, Math.min(panel.cursor, visible.length - 1));
  return visible[clamped] ?? null;
}
