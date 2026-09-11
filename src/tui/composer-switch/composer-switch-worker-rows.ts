import type { TuiState } from "../tui-state.js";
import {
  configuredCloudProviders,
  localSliceLoadingRows,
  type ComposerSwitchRow,
} from "./composer-switch-rows.js";

/**
 * The rows of the composer's fourth control, `workers` — drawn only on
 * the fusion route. This is fusion's second SLOT: who runs the workers.
 * Either kind may hold it. The default pairing is a cloud orchestrator
 * with local workers, because that is the economics the mode was built
 * for, but the reverse — a local model planning, cloud models executing
 * — is a real use case and is one Enter away here.
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
  const runMode = state.providersPanel.runMode;
  const localHoldsTheSlot = runMode?.workerProviderId === "local-llama";
  const models = state.localModelsPanel.rows
    .filter((row) => row.downloaded)
    .map((row) => ({
      id: `worker:model:${row.id}`,
      label: row.id,
      detail: "workers · on this machine",
      // Active only when the local leg actually holds the slot: a
      // downloaded model the workers are not running is not in force,
      // however active the daemon considers it.
      active: localHoldsTheSlot && row.active,
      intent: { kind: "fusionWorkerModel" as const, modelId: row.id },
    }));
  // The other kind of worker. A cloud provider here is the whole point
  // of the slot being a slot: cheap local planning, capable cloud
  // execution, chosen per use case rather than baked into the mode.
  const cloud = configuredCloudProviders(state)
    .filter((provider) => provider.id !== runMode?.orchestratorProviderId)
    .map((provider) => ({
      id: `worker:provider:${provider.id}`,
      label: provider.id,
      detail: provider.hasApiKey ? "workers · in the cloud" : "no API key",
      active: runMode?.workerProviderId === provider.id,
      intent: {
        kind: "fusionLeg" as const,
        leg: "worker" as const,
        providerId: provider.id,
      },
    }));
  return [
    ...localSliceLoadingRows(state),
    ...models,
    ...cloud,
    {
      id: "worker:model:download-more",
      label: "Download more models…",
      detail: "opens the local models pane",
      active: false,
      intent: { kind: "localModelsPanel" as const },
    },
  ];
}
