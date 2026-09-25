/**
 * How many rows the composer's adaptive chrome is spending **above** its
 * one-row baseline, so the chat surface can hand them over instead of
 * being painted on top of.
 *
 * `CHROME_ROWS` in `layout.ts` counts one row for the hint strip and one
 * for the composer's meta bar, which is what both took when neither was
 * allowed to wrap. Now that they are, the surplus has to come from
 * somewhere, and the only honest source is the transcript: a viewport
 * that ignored the surplus would keep its bottom rows hidden behind the
 * composer, and one that over-counted would leave a blank stripe above
 * it (the trap `composer-overlay.tsx` documents for `ComposerSlot`).
 *
 * Deliberately a pure function of `(state, terminal)` rather than a prop
 * threaded down from `TuiApp`: `ChatLog`, `SplashBanner` and the debug
 * pane's own budget all need the same number, and three props are three
 * chances for one call site to keep the old baseline.
 */
import { layoutChipRows } from "./components/hotkey-chip-rows.js";
import { resolveChips } from "./components/hotkey-chips.js";
import {
  computeHintRowBudget,
  computeMainColumnWidth,
  isSidebarVisible,
} from "./layout.js";
import type { TuiState } from "./tui-state.js";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * Rows the hint strip paints at this size.
 *
 * `ctrlCArmed` and `menuLeaderArmed` are not on `TuiState` — they are
 * `TuiApp` locals — so this reads the unarmed chip set. Both armed
 * states collapse the strip to one or two chips, i.e. strictly fewer
 * rows than the set measured here, so the viewport is never short by
 * this; at worst it holds a spare row for the second an armed chord
 * lives.
 */
export function selectHintRows(
  state: TuiState,
  terminal: TerminalSize,
): number {
  const width = computeMainColumnWidth(
    terminal.columns,
    selectRailVisible(state, terminal),
  );
  if (width <= 0) return 1;
  return layoutChipRows(
    resolveChips(state, false, false),
    width,
    computeHintRowBudget(terminal.rows),
  ).length;
}

/**
 * The surplus over the baseline — what a viewport subtracts. Zero on a
 * terminal wide enough that nothing wraps, which is the case every
 * pinned layout number was measured against.
 */
export function selectExtraChromeRows(
  state: TuiState,
  terminal: TerminalSize,
): number {
  return Math.max(0, selectHintRows(state, terminal) - 1);
}

/**
 * Is the rail on screen? Geometry is only half of it — the panels hide
 * it and the operator can fold it away — so `TuiApp` and this file go
 * through one predicate rather than repeating the conjunction.
 */
export function selectRailVisible(
  state: TuiState,
  terminal: TerminalSize,
): boolean {
  return (
    state.uiMode === "chat" &&
    !state.sidebarCollapsed &&
    isSidebarVisible(terminal.columns, terminal.rows)
  );
}
