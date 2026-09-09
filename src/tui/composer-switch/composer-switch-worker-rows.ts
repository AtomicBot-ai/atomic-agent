import { FUSION_WORKERS_MAX, FUSION_WORKERS_MIN } from "../../config/llm-run-mode-config.js";
import type { TuiState } from "../tui-state.js";
import { localSliceLoadingRows, type ComposerSwitchRow } from "./composer-switch-rows.js";

/**
 * The rows of the composer's fourth control, `workers` — drawn only on
 * the fusion route. Two things are configured here and nowhere else in
 * the composer: which local model the workers run, and how many may run
 * at once.
 *
 * The model rows are what is on disk, the same rule the local model
 * switch follows (a catalog row would put a multi-gigabyte download one
 * Enter away from "pick a worker model"); the catalog stays reachable
 * through the deep-link row. Picking one restarts the managed daemon on
 * it through the local-models orchestrator, which never touches
 * `activeTextProvider`, so fusion stays effective across the pick.
 *
 * The count rows mirror `llm.runMode.fusion.workers` and, in the same
 * write, `localModels.managed.parallel` — the llama-server slot count
 * that lets N workers actually run side by side rather than queue on
 * the server. A running daemon keeps its old slot count until it is
 * restarted, which the orchestrator says in a notice.
 */
export function selectWorkerRows(state: TuiState): readonly ComposerSwitchRow[] {
  const workers = state.providersPanel.runMode?.workers ?? 2;
  const external = state.localModelsPanel.configMode === "external";
  // The panel's own `active` flag, not the LLM pane's row: that one
  // means "local-llama is the chat route", which under fusion it never
  // is — the cloud orchestrator holds that seat. What matters here is
  // which model the managed daemon serves.
  const models = state.localModelsPanel.rows
    .filter((row) => row.downloaded)
    .map((row) => ({
      id: `worker:model:${row.id}`,
      label: row.id,
      detail: "worker model",
      active: row.active,
      intent: { kind: "fusionWorkerModel" as const, modelId: row.id },
    }));
  const counts: ComposerSwitchRow[] = [];
  for (let n = FUSION_WORKERS_MIN; n <= FUSION_WORKERS_MAX; n += 1) {
    counts.push({
      id: `worker:count:${n}`,
      label: `${n} worker${n === 1 ? "" : "s"}`,
      detail: external
        ? "external server — set --parallel yourself"
        : `llama-server --parallel ${n} · restart to apply`,
      active: n === workers,
      intent: { kind: "fusionWorkers" as const, workers: n },
    });
  }
  return [
    ...localSliceLoadingRows(state),
    ...models,
    ...counts,
    {
      id: "worker:model:download-more",
      label: "Download more models…",
      detail: "opens the local models pane",
      active: false,
      intent: { kind: "localModelsPanel" as const },
    },
  ];
}

/** The fourth control's word on the meta bar, `null` off the fusion route. */
export function selectComposerWorkersLabel(state: TuiState): string | null {
  const runMode = state.providersPanel.runMode;
  if (runMode?.effective !== "fusion") return null;
  return `${runMode.workers} worker${runMode.workers === 1 ? "" : "s"}`;
}
