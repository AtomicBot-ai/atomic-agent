import type { TuiState } from "../tui-state.js";
import {
  localSliceLoadingRows,
  type ComposerSwitchRow,
} from "./composer-switch-rows.js";

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
 * There are no count rows. How many workers a fan-out runs is the
 * orchestrator's call per call, bounded by what the machine serves —
 * `localModels.managed.parallel: "auto"` derives the slot count from the
 * context the daemon launches with (`worker-slots.ts`), and the `###
 * fusion` block states it so the model chooses against a real number.
 * An operator picking it from a list was choosing for two parties that
 * both know better: the machine, which knows its capacity, and the
 * model, which knows how divisible this job is.
 */
export function selectWorkerRows(
  state: TuiState,
): readonly ComposerSwitchRow[] {
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
  return [
    ...localSliceLoadingRows(state),
    ...models,
    {
      id: "worker:model:download-more",
      label: "Download more models…",
      detail: "opens the local models pane",
      active: false,
      intent: { kind: "localModelsPanel" as const },
    },
  ];
}

/**
 * The fourth control's word on the meta bar, `null` off the fusion route.
 *
 * "up to N", not "N workers": the number is what this machine can serve
 * at once, and how many of them a given turn actually spends is the
 * orchestrator's decision on that turn. The old wording read as a
 * setting, which is precisely what it no longer is.
 */
export function selectComposerWorkersLabel(state: TuiState): string | null {
  const runMode = state.providersPanel.runMode;
  if (runMode?.effective !== "fusion") return null;
  return `up to ${runMode.workers} worker${runMode.workers === 1 ? "" : "s"}`;
}
