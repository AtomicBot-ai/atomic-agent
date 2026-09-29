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
import { codingModeChipLabel } from "./components/coding-mode-chip.js";
import { contextChipLabel } from "./components/context-chip.js";
import { layoutChipRows } from "./components/hotkey-chip-rows.js";
import { resolveChips } from "./components/hotkey-chips.js";
import {
  planMetaBar,
  type MetaBarParts,
  type MetaBarPlan,
} from "./components/meta-bar-rows.js";
import { composerModelLabel } from "./components/prompt-meta-bar.js";
import {
  selectComposerBackendMeta,
  selectComposerNeedsModelDownload,
} from "./composer-switch/index.js";
import { composerRouteWidth } from "./composer-switch/composer-meta-controls.js";
import { formatProviderOutageParts } from "./format-provider-outage.js";
import {
  computeHintRowBudget,
  computeMainColumnWidth,
  isSidebarVisible,
} from "./layout.js";
import { selectPromptLlmMeta } from "./llm-panel/llm-panel-selectors.js";
import { selectComposerContextUsage } from "./select-context-usage.js";
import type { TuiState } from "./tui-state.js";

/**
 * Columns the composer's frame and its horizontal padding cost, so the
 * bar's own width is the main column less this. Two border columns and
 * one of padding on each side — counted off `prompt-shell.tsx`'s frame
 * and pinned by the fit test.
 */
export const COMPOSER_FRAME_COLUMNS = 4;

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
  const hint = Math.max(0, selectHintRows(state, terminal) - 1);
  const meta = Math.max(0, selectMetaBarRows(state, terminal) - 1);
  return hint + meta;
}

/**
 * The widths the composer's meta bar has to seat, measured off the same
 * state the bar renders from and with the same helpers the components
 * paint with — `composerRouteWidth`, `contextChipLabel`,
 * `codingModeChipLabel`, `composerModelLabel`.
 *
 * `TuiApp` hands the result to `PromptMetaBar` as its `fit`, and to
 * `ComposerSlot` as a height. One computation, two consumers: the bar
 * cannot paint a shape the slot did not reserve for.
 */
export function selectMetaBarFit(
  state: TuiState,
  terminal: TerminalSize,
): MetaBarParts {
  const barColumns = Math.max(
    0,
    computeMainColumnWidth(
      terminal.columns,
      selectRailVisible(state, terminal),
    ) - COMPOSER_FRAME_COLUMNS,
  );
  const llm = selectPromptLlmMeta(state);
  const usage = selectComposerContextUsage(state);
  return {
    barColumns,
    terminalRows: terminal.rows,
    routeWidth: composerRouteWidth({
      backend: selectComposerBackendMeta(state),
      provider: llm.provider,
      model: llm.model === null ? null : composerModelLabel(llm.model),
      needsModelDownload: selectComposerNeedsModelDownload(state),
    }),
    noticeWidth: leftSlotWidth(state),
    contextWidth: usage ? contextChipLabel(usage).length : 0,
    // Always drawn, including in `default` — see `promptModeSlot`.
    modeWidth: codingModeChipLabel(state.codingMode).length,
  };
}

/** Rows the meta bar paints, padding excluded. */
export function selectMetaBarRows(
  state: TuiState,
  terminal: TerminalSize,
): number {
  return selectMetaBarPlan(state, terminal).rows;
}

/** The bar's whole plan, for the caller that also needs its shape. */
export function selectMetaBarPlan(
  state: TuiState,
  terminal: TerminalSize,
): MetaBarPlan {
  return planMetaBar(selectMetaBarFit(state, terminal));
}

/**
 * The left slot's rigid width.
 *
 * An outage readout is a rigid head plus a reason that grows into
 * leftovers from a zero basis (`flexGrow`, never `flexShrink` — see
 * `provider-outage-readout.tsx`), so only the head can force the route
 * onto another line; counting the reason too would buy rows nothing
 * needs. A composer notice has no such split and is measured whole.
 */
function leftSlotWidth(state: TuiState): number {
  const outage = state.providerOutage;
  if (outage) return formatProviderOutageParts(outage).head.length;
  return state.composerNotice?.length ?? 0;
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
