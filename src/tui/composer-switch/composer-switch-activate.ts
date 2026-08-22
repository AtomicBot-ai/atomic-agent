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
    triggerLlmPrimary(row.intent.row, state, dispatch, callbacks);
    return;
  }
  if (row.intent.kind === "addProvider") {
    goToLlmPane(dispatch, "cloud");
    openAddProvider(dispatch);
    return;
  }
  activateBackend(row.intent.backend, state, dispatch, callbacks);
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
  // A custom backend is a base URL, and a base URL has to be typed and
  // probed before it can be the route — see `persistUserLocalLlmUrl`.
  // The External pane's single row opens exactly that editor.
  goToLlmPane(dispatch, "external");
  triggerLlmPrimary(selectExternalRows(state)[0] ?? null, state, dispatch, callbacks);
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
  triggerLlmPrimary(cloudProviderRow(provider), state, dispatch, callbacks);
}

/**
 * Local means the managed llama.cpp. Routing to it is the provider
 * switch plus, when a downloaded model is already chosen, the daemon
 * start `triggerLlmPrimary` does for that row.
 *
 * With nothing downloaded there is no honest one-key answer — a
 * multi-gigabyte pull is not what "switch to local" promised — so the
 * route is pointed at `local-llama` and the model switch is opened on
 * the catalog, where each row states its own download.
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
  if (!ready) {
    callbacks.onProvidersSetActiveText?.("local-llama");
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
  mode: "cloud" | "external",
): void {
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: "llm" });
  dispatch({ type: "llm_mode_set", mode });
}
