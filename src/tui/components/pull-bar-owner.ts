import { isLocalModelsHfOpen } from "../local-models/local-models-hf-keys.js";
import type { LocalModelsPanelState } from "../local-models/local-models-panel-state.js";
import type { TuiState } from "../tui-state.js";
import { hasLlmModal } from "../llm-panel/llm-panel-modals.js";

/**
 * Who draws the bar for a running download. One download, one bar.
 *
 * A model pull used to be drawn three times on the Models tab: the
 * status bar's chip, the panel's `downloading —` banner, and a mini
 * `[====    ]` on the row being pulled — three bars racing each other
 * for one transfer, which read as three downloads. The rule now:
 *
 *   - the row says which model is downloading and how far, as text;
 *   - the panel banner is the bar, while a panel that has one is on
 *     screen;
 *   - the status-bar chip is the bar everywhere else, because the pull
 *     outlives the tab that started it.
 *
 * The two predicates below are the panels' own render conditions for
 * the banner, so the chip and the banner can never both be up.
 */

/** Whether `LocalModelsPanel` is on its list view, where the banner lives. */
export function localModelsPanelDrawsPullBanner(
  panel: LocalModelsPanelState,
): boolean {
  if (panel.pull === null && panel.embeddingPull === null) return false;
  // Every other mode is an early return in `LocalModelsPanel` that owns
  // the whole pane and draws no banner.
  return (
    panel.mode !== "backendUpdate" &&
    panel.mode !== "hfRef" &&
    panel.mode !== "hfPick" &&
    panel.mode !== "detail"
  );
}

/** Whether `LlmPanel` draws its download banner in this state. */
export function llmPanelDrawsPullBanner(state: TuiState): boolean {
  const panel = state.localModelsPanel;
  if (panel.pull === null && panel.embeddingPull === null) return false;
  if (state.llmPanel.mode !== "local") return false;
  // The modal, Hugging Face and detail branches of `LlmPanel` replace
  // the whole pane, banner included.
  if (hasLlmModal(state) || isLocalModelsHfOpen(state)) return false;
  return panel.mode !== "detail";
}

/**
 * Whether the surface on screen already draws the pull's bar, so the
 * status-bar chip should stand down.
 */
export function pullBarOnScreen(state: TuiState): boolean {
  if (state.uiMode !== "debug") return false;
  if (state.activeTab === "models") {
    return localModelsPanelDrawsPullBanner(state.localModelsPanel);
  }
  if (state.activeTab === "llm") return llmPanelDrawsPullBanner(state);
  return false;
}
