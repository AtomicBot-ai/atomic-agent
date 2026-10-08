import type { LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import type { LocalModelId } from "../../local-llm/index.js";
import type { TuiState } from "../tui-state.js";
import type { ComposerBackendKind } from "./composer-switch-state.js";

/**
 * What activating a row does. `llmRow` is the important one: it carries
 * a real `LlmPanelRow`, so the composer's switches select a provider or
 * a model through `triggerLlmPrimary` — the same call the LLM tab makes
 * — instead of growing a second switching implementation next to
 * `ProvidersOrchestrator`.
 */
export type ComposerSwitchIntent =
  | { readonly kind: "localEngine"; readonly engine: "atomic-core" | "llama-server"; readonly leg?: "orchestrator" | "worker" }
  | { readonly kind: "fusionModel"; readonly leg: "orchestrator" | "worker"; readonly modelId: string }
  | { readonly kind: "backend"; readonly backend: ComposerBackendKind }
  | { readonly kind: "llmRow"; readonly row: LlmPanelRow }
  | { readonly kind: "addProvider" }
  /**
   * Deep link to Manage › LLM › Local — the pane where models are
   * downloaded. The local model switch lists only what is on disk, so
   * this row is its way of saying "more exists than you see here".
   */
  | { readonly kind: "localModelsPanel" }
  /** Fusion's `workers` control: the local model the workers run. */
  | { readonly kind: "fusionWorkerModel"; readonly modelId: LocalModelId }
  /**
   * Pin one of fusion's two legs to a provider — either leg, either
   * kind. The default pairing is cloud orchestrator + local workers, but
   * a local model planning for cloud executors is a legitimate use case
   * and the composer is where it gets chosen.
   */
  | {
      readonly kind: "fusionLeg";
      readonly leg: "orchestrator" | "worker";
      readonly providerId: string;
    }
  /** Fusion's `workers` control: how many workers run at once. */
  | { readonly kind: "fusionWorkers"; readonly workers: number };

export interface ComposerSwitchRow {
  readonly id: string;
  readonly label: string;
  /** Second column: what choosing this row would mean. */
  readonly detail: string;
  readonly active: boolean;
  readonly intent: ComposerSwitchIntent;
  /**
   * Rows drawn as something other than rail text. `fusion` paints the
   * label as the orange chip the meta bar shows for that route, so the
   * row and the control it opens from read as the same thing.
   */
  readonly emphasis?: "fusion";
}

/** Cloud providers the operator has actually added, in config order. */
export function configuredCloudProviders(state: TuiState) {
  return state.providersPanel.rows.filter((row) => row.kind !== "llama-server");
}

/**
 * One "loading…" row until the first local-models snapshot lands. The
 * slice is refreshed by the Models/LLM tab's loop and, since the switch
 * must be truthful from anywhere, by the switch-open effect in
 * `tui-app.tsx` — but right after boot `rows` is still empty even with
 * models on disk, and an empty list here would read as "nothing
 * downloaded". Enter on the row deep-links to the pane the list lives
 * in, same as the download row.
 */
export function localSliceLoadingRows(
  state: TuiState,
): readonly ComposerSwitchRow[] {
  const panel = state.localModelsPanel;
  if (panel.lastRefreshedAt !== null || panel.rows.length > 0) return [];
  return [
    {
      id: "model:local:loading",
      label: "loading…",
      detail: "reading what is on disk",
      active: false,
      intent: { kind: "localModelsPanel" as const },
    },
  ];
}
