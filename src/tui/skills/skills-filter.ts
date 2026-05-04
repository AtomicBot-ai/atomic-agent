import type {
  SkillSummaryRow,
  SkillsFilterStatus,
  SkillsPanelState,
} from "./skills-panel-state.js";

/**
 * Pure filter applied to the in-memory skills snapshot before it
 * reaches the list component. Ordering: enabled first (alphabetical),
 * then disabled (alphabetical), so the operator's eye lands on
 * actively-used skills before the dormant ones.
 */
export interface SkillsFilter {
  status: SkillsFilterStatus;
}

export function filterAndSortSkillRows(
  rows: readonly SkillSummaryRow[],
  filter: SkillsFilter,
): SkillSummaryRow[] {
  const matched = rows.filter((row) => matchesStatus(row, filter.status));
  return matched.slice().sort(compareSkillRows);
}

function matchesStatus(
  row: SkillSummaryRow,
  status: SkillsFilterStatus,
): boolean {
  switch (status) {
    case "all":
      return true;
    case "enabled":
      return !row.disabled;
    case "disabled":
      return row.disabled;
  }
}

function compareSkillRows(a: SkillSummaryRow, b: SkillSummaryRow): number {
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * Cycle through the filter buckets in the order used by the `f`
 * keypress.
 */
const FILTER_ORDER: readonly SkillsFilterStatus[] = [
  "all",
  "enabled",
  "disabled",
];

export function cycleSkillsFilter(
  current: SkillsFilterStatus,
  direction: 1 | -1 = 1,
): SkillsFilterStatus {
  const idx = FILTER_ORDER.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + FILTER_ORDER.length) % FILTER_ORDER.length;
  return FILTER_ORDER[next] ?? "all";
}

export function listSkillsFilterOrder(): readonly SkillsFilterStatus[] {
  return FILTER_ORDER;
}

/**
 * Single source of truth for the filtered+sorted row slice used by
 * the list component, the keyboard layer and the reducer. Centralising
 * the selector ensures cursor clamping and visual chevron position
 * operate on the exact same row order.
 */
export function selectVisibleSkillRows(
  panel: Pick<SkillsPanelState, "rows" | "filterStatus">,
): SkillSummaryRow[] {
  return filterAndSortSkillRows(panel.rows, { status: panel.filterStatus });
}
