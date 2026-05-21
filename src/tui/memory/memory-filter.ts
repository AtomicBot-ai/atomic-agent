import {
  MEMORY_CHANNEL_ORDER,
  type MemoryChannel,
  type MemoryNotesArchiveFilter,
  type MemoryPanelState,
} from "./memory-panel-state.js";
import type { MemorySummaryRow } from "./memory-panel-state.js";

export function selectVisibleMemoryRows(
  panel: MemoryPanelState,
): readonly MemorySummaryRow[] {
  const q = panel.searchQuery.trim().toLowerCase();
  if (q.length === 0) return panel.rows;
  return panel.rows.filter(
    (row) =>
      row.primary.toLowerCase().includes(q) ||
      row.secondary.toLowerCase().includes(q) ||
      row.meta.toLowerCase().includes(q),
  );
}

export function cycleMemoryChannel(
  current: MemoryChannel,
  available: readonly MemoryChannel[],
  direction: 1 | -1,
): MemoryChannel {
  const order =
    available.length > 0 ? available : MEMORY_CHANNEL_ORDER;
  const idx = order.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + order.length) % order.length;
  return order[next] ?? order[0] ?? "profile";
}

const NOTES_FILTERS: readonly MemoryNotesArchiveFilter[] = [
  "active",
  "archived",
  "all",
];

export function cycleNotesArchiveFilter(
  current: MemoryNotesArchiveFilter,
  direction: 1 | -1,
): MemoryNotesArchiveFilter {
  const idx = NOTES_FILTERS.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + NOTES_FILTERS.length) % NOTES_FILTERS.length;
  return NOTES_FILTERS[next] ?? "active";
}
