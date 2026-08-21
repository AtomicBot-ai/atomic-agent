import type { TuiState } from "./tui-state.js";
import type { ContextUsageSection } from "./tui-state.js";

/**
 * What the composer's context chip draws.
 *
 * `percent` is `null` whenever the denominator is unknown, which is not
 * an edge case: a cloud model whose window nobody has stated has a real
 * token count and no honest gauge. The chip renders the count alone
 * rather than inventing a scale for it.
 */
export interface ContextUsageView {
  tokens: number;
  contextWindow: number | null;
  percent: number | null;
  /**
   * Turns `packConversation` dropped to make the transcript fit. Any
   * non-zero value is the chip's violet state; the detail view spends
   * the actual number.
   */
  droppedTurns: number;
  sections: readonly ContextUsageSection[];
}

/**
 * Resolve the window the last prompt was measured against.
 *
 * Order matters. The prompt's own `contextWindow` is what the budget
 * actually enforced, so it wins wherever the runtime has it (the
 * llama-server `/props` probe). Cloud turns build with `null` there, and
 * fall through to what the active provider row knows about its chat
 * model. Neither: no gauge.
 */
function resolveWindow(state: TuiState): number | null {
  const fromPrompt = state.contextUsage.contextWindow;
  if (fromPrompt !== null && fromPrompt > 0) return fromPrompt;
  const active = state.providersPanel.rows.find((row) => row.isActiveText);
  const fromProvider = active?.contextWindow ?? null;
  return fromProvider !== null && fromProvider > 0 ? fromProvider : null;
}

export function selectContextUsage(state: TuiState): ContextUsageView | null {
  const { tokens, droppedTurns, sections } = state.contextUsage;
  // Nothing has been built yet: the chip stays off the bar rather than
  // showing a zero, which would claim the window is empty when what we
  // actually know is nothing.
  if (tokens === null) return null;
  const contextWindow = resolveWindow(state);
  const percent =
    contextWindow === null
      ? null
      : Math.min(100, Math.round((tokens / contextWindow) * 100));
  return {
    tokens,
    contextWindow,
    percent,
    droppedTurns,
    sections,
  };
}
