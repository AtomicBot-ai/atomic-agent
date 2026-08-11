import type { TuiState } from "../../tui-state.js";
import type { FallbackLinkRow } from "./fallback-panel-state.js";

/**
 * Flat rows of the Fallback pane, in render/cursor order: one `link` row
 * per chain member, then a single `add` affordance row when at least one
 * provider is still addable. The cursor (`llmPanel.fallbackCursor`) walks
 * this list; the key handler and the renderer both derive from it so they
 * never disagree on what is selected.
 */
export type FallbackPaneRow =
  | { kind: "link"; link: FallbackLinkRow; index: number }
  | { kind: "add" };

export function selectFallbackPaneRows(
  state: TuiState,
): readonly FallbackPaneRow[] {
  const rows: FallbackPaneRow[] = state.fallbackPanel.links.map(
    (link, index) => ({ kind: "link", link, index }),
  );
  if (state.fallbackPanel.addableProviderIds.length > 0) {
    rows.push({ kind: "add" });
  }
  return rows;
}

export function clampFallbackCursor(state: TuiState, cursor: number): number {
  const rows = selectFallbackPaneRows(state);
  if (rows.length === 0) return 0;
  return Math.min(rows.length - 1, Math.max(0, cursor));
}

export function fallbackRowAt(
  state: TuiState,
  cursor: number = state.llmPanel.fallbackCursor,
): FallbackPaneRow | null {
  const rows = selectFallbackPaneRows(state);
  if (rows.length === 0) return null;
  return rows[Math.min(Math.max(0, cursor), rows.length - 1)] ?? null;
}
