import {
  cloudProviderRow,
  selectExternalRows,
  selectLocalRows,
} from "../llm-panel/llm-panel-row-builders.js";
import {
  openAddProvider,
  triggerLlmPrimary,
} from "../llm-panel/llm-panel-primary-actions.js";
import type { LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { describeFusionBlocker } from "../run-mode/fusion-preflight.js";
import type { ComposerBackendKind } from "./composer-switch-state.js";
import type { ComposerSwitchRow } from "./composer-switch-rows.js";

/**
 * Run a row the operator picked in one of the composer's switches.
 *
 * Every path here ends in something that already existed: a provider or
 * a model row goes through `triggerLlmPrimary`, which is the LLM tab's
 * own Enter, and therefore reaches `ProvidersOrchestrator.setActiveText`
 * / `.selectChatModel` through the same callbacks the tab uses. Nothing
 * in this file writes config or touches the provider registry itself.
 *
 * The two backends that need a surface the composer does not own — the
 * provider wizard and the external base-URL editor — first send the
 * operator to Manage › LLM, where those modals are rendered. Opening a
 * modal that only the LLM tab draws while the operator is looking at the
 * chat would be a keypress with no visible effect.
 */
export function runComposerSwitchRow(
  row: ComposerSwitchRow,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  // Closing first is what lets an activation re-open the strip on
  // another control — see `activateLocal`. Shared by the Enter binding
  // and the row's click handler so the two cannot drift apart.
  dispatch({ type: "composer_switch_closed" });
  activateComposerSwitchRow(row, state, dispatch, callbacks);
}

export function activateComposerSwitchRow(
  row: ComposerSwitchRow,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (row.intent.kind === "llmRow") {
    const llmRow = row.intent.row;
    if (
      llmRow.kind === "cloudProvider" &&
      llmRow.provider.hasApiKey &&
      state.providersPanel.runMode?.effective === "fusion"
    ) {
      // Under fusion the provider control re-pins the orchestrator. The
      // LLM tab's own `setActiveText` would move `activeTextProvider`
      // away from the pinned orchestrator and drop the mode on the next
      // read; the run-mode write moves the pin and the provider together.
      callbacks.onRunModeChangeRequested?.("fusion", {
        fusion: { orchestratorProvider: llmRow.provider.id },
      });
      return;
    }
    triggerLlmPrimary(llmRow, state, dispatch, callbacks);
    return;
  }
  if (row.intent.kind === "fusionWorkerModel") {
    activateWorkerModel(row.intent.modelId, state, callbacks);
    return;
  }
  if (row.intent.kind === "fusionWorkers") {
    callbacks.onFusionWorkersChangeRequested?.(row.intent.workers);
    return;
  }
  if (row.intent.kind === "addProvider") {
    goToLlmPane(dispatch, "cloud");
    openAddProvider(dispatch);
    return;
  }
  if (row.intent.kind === "localModelsPanel") {
    openLocalModelsPane(dispatch);
    return;
  }
  activateBackend(row.intent.backend, state, dispatch, callbacks);
}

/**
 * Manage › LLM › Local — where models are downloaded and removed. The
 * model switch's "Download more models…" row and the composer's
 * daemon-status control both land here, one deep link for both.
 */
export function openLocalModelsPane(
  dispatch: (action: TuiAction) => void,
): void {
  goToLlmPane(dispatch, "local");
}

function activateBackend(
  backend: ComposerBackendKind,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (backend === "cloud") {
    activateCloud(state, dispatch, callbacks);
    return;
  }
  if (backend === "local") {
    activateLocal(state, dispatch, callbacks);
    return;
  }
  if (backend === "fusion") {
    activateFusion(state, dispatch, callbacks);
    return;
  }
  // A custom backend is a base URL, and a base URL has to be typed and
  // probed before it can be the route — see `persistUserLocalLlmUrl`.
  // The External pane's single row opens exactly that editor.
  goToLlmPane(dispatch, "external");
  triggerLlmPrimary(selectExternalRows(state)[0] ?? null, state, dispatch, callbacks);
}

/**
 * Fusion is a mode over the cloud and local routes, so it needs both: a
 * keyed cloud provider to orchestrate and a downloaded local model for
 * the workers. The pre-flight is the one line the row's detail column
 * already shows; on a pass the change goes to `RunModeOrchestrator`,
 * which re-checks from config, writes the mode and the orchestrator
 * provider in one write and starts the worker daemon.
 */
function activateFusion(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  const blocker = describeFusionBlocker(state);
  if (blocker) {
    dispatch({ type: "composer_notice", text: `fusion: ${blocker}` });
    dispatch({ type: "runtime_info", line: `fusion: ${blocker}` });
    return;
  }
  callbacks.onRunModeChangeRequested?.("fusion");
}

/**
 * The worker model is the managed daemon's model. `setActive` on the
 * local-models orchestrator restarts the daemon on it and writes only
 * `localModels.*` — never `activeTextProvider` — so fusion survives the
 * pick. `triggerLlmPrimary` is deliberately NOT used: its local branch
 * also makes `local-llama` the active text provider, which under fusion
 * is exactly the switch that would drop the mode.
 */
function activateWorkerModel(
  modelId: import("../../local-llm/index.js").LocalModelId,
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  const row = state.localModelsPanel.rows.find((candidate) => candidate.id === modelId);
  const chatUp =
    state.localModelsPanel.daemon.running ||
    state.localModelsPanel.daemonPhase === "starting";
  if (row?.active && chatUp) return;
  if (row?.active) {
    callbacks.onLocalModelsDaemonStartRequested?.();
    return;
  }
  callbacks.onLocalModelsSetActiveRequested?.(modelId);
}

/** A stored fusion that a plain cloud/local pick must clear in the same write. */
function leavingFusion(state: TuiState): boolean {
  return state.providersPanel.runMode?.stored === "fusion";
}

/**
 * Cloud means "the provider that is already active, or the first one
 * that could be". An entry without credentials still selects: its row's
 * primary action is `configure`, so `triggerLlmPrimary` opens the wizard
 * for it instead of activating a provider that cannot answer.
 */
function activateCloud(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  const cloud = state.providersPanel.rows.filter(
    (row) => row.kind !== "llama-server",
  );
  const provider =
    cloud.find((row) => row.isActiveText) ??
    cloud.find((row) => row.hasApiKey) ??
    cloud[0];
  if (!provider) {
    goToLlmPane(dispatch, "cloud");
    openAddProvider(dispatch);
    return;
  }
  if (!provider.hasApiKey) goToLlmPane(dispatch, "cloud");
  if (provider.hasApiKey && leavingFusion(state)) {
    // `setActiveText` alone would leave `llm.runMode.mode: "fusion"` in
    // the file; the run-mode write moves both keys together.
    callbacks.onRunModeChangeRequested?.("cloud");
    return;
  }
  triggerLlmPrimary(cloudProviderRow(provider), state, dispatch, callbacks);
}

/**
 * Local means the managed llama.cpp. Routing to it is the provider
 * switch plus, when a downloaded model is already chosen, the daemon
 * start `triggerLlmPrimary` does for that row.
 *
 * With nothing downloaded there is no honest one-key answer — a
 * multi-gigabyte pull is not what "switch to local" promised — so the
 * route is pointed at `local-llama` and the model switch opens, whose
 * "Download more models…" row leads to the pane where pulls are stated
 * per row.
 */
function activateLocal(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  const rows = selectLocalRows(state).filter(isLocalTextRow);
  const ready =
    rows.find((row) => row.model.active && row.model.downloaded) ??
    rows.find((row) => row.model.downloaded);
  // Out of fusion, the provider swap is the run-mode write (both keys
  // at once); the model logic below is unchanged and still the local
  // models orchestrator's own.
  const setActiveLocal = (): void => {
    if (leavingFusion(state)) callbacks.onRunModeChangeRequested?.("local");
    else callbacks.onProvidersSetActiveText?.("local-llama");
  };
  if (!ready) {
    setActiveLocal();
    // With no model to set active, nothing downstream would write
    // `localModels.mode: "managed"` — and the config still saying
    // `external` is exactly the bug where this control read `custom`
    // right after the operator picked `local`.
    callbacks.onLocalModelsUseManagedRequested?.();
    dispatch({ type: "composer_switch_opened", kind: "model" });
    return;
  }
  // Coming from `custom`, the model is very likely already the active
  // one, and `triggerLlmPrimary` skips the set-active call for a row
  // that is already active. That call is the only thing that writes
  // `localModels.mode: "managed"` (see `LocalModelsOrchestrator`), so
  // without it the switch would activate a provider and leave the
  // config still pointing at the operator's own base URL — the control
  // would read `custom` again on the next frame.
  if (state.localModelsPanel.configMode === "external") {
    callbacks.onLocalModelsSetActiveRequested?.(ready.model.id);
  }
  if (leavingFusion(state)) setActiveLocal();
  triggerLlmPrimary(ready, state, dispatch, callbacks);
}

function isLocalTextRow(
  row: LlmPanelRow,
): row is Extract<LlmPanelRow, { kind: "localTextModel" }> {
  return row.kind === "localTextModel";
}

/** Manage › LLM, on the pane whose modals the caller is about to open. */
function goToLlmPane(
  dispatch: (action: TuiAction) => void,
  mode: "cloud" | "external" | "local",
): void {
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: "llm" });
  dispatch({ type: "llm_mode_set", mode });
}
