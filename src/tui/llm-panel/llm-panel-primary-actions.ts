import type {
  EmbeddingModelRow,
  LocalModelRow,
} from "../local-models/local-models-panel-state.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { isCloudProviderKind } from "../providers/providers-orchestrator.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { LlmPanelRow } from "./llm-panel-selectors.js";
import { isLocalTextActive } from "./llm-panel-selectors.js";
import { nextMode } from "./llm-panel-reducer.js";

export function triggerLlmPrimary(
  row: LlmPanelRow | null,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (!row) return;
  switch (row.kind) {
    case "localTextModel":
      triggerLocalChatModel(row.model, state, callbacks);
      return;
    case "localEmbeddingModel":
      triggerLocalEmbeddingModel(row.model, state, callbacks);
      return;
    case "localAddHuggingFace":
      dispatch({ type: "llm_hf_prompt_opened" });
      return;
    case "localDaemon":
      triggerDaemonAction(state, callbacks);
      return;
    case "localBackend":
      callbacks.onLocalModelsBackendPullRequested?.();
      return;
    case "cloudProvider":
      triggerCloudProvider(row, state, dispatch, callbacks);
      return;
    case "cloudChatModel":
      triggerCloudChatModel(row, state, dispatch, callbacks);
      return;
    case "cloudEmbeddingModel":
      triggerCloudEmbeddingModel(row, dispatch, callbacks);
      return;
    case "externalUrl":
      dispatch({ type: "llm_external_url_draft_set", value: row.url });
      return;
  }
}

/** Move `delta` panes (right = +1, left = -1), wrapping at both ends. */
export function switchLlmMode(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  delta = 1,
): void {
  dispatch({ type: "llm_mode_set", mode: nextMode(state.llmPanel.mode, delta) });
}

export function openProviderConfig(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
): void {
  const provider =
    state.providersPanel.rows.find(
      (row) => isCloudProviderKind(row.kind) && row.isActiveText,
    ) ?? state.providersPanel.rows.find((row) => isCloudProviderKind(row.kind));
  if (provider) openProviderConfigFor(provider, dispatch);
  else {
    dispatch({ type: "providers_catalog_refresh_requested" });
    dispatch({
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    });
  }
}

export function openAddProvider(dispatch: (action: TuiAction) => void): void {
  dispatch({ type: "providers_catalog_refresh_requested" });
  dispatch({
    type: "providers_wizard_opened",
    wizard: createProvidersWizardState("add"),
  });
}

export function activateProviderEmbedding(
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  const active = state.providersPanel.rows.find(
    (row) => row.isActiveText && row.kind !== "llama-server" && row.embeddingModel,
  );
  if (active) callbacks.onProvidersSetActiveEmbedding?.(active.id);
}

export function triggerDaemonAction(
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  const running =
    state.localModelsPanel.daemon.running ||
    state.localModelsPanel.daemonPhase === "starting";
  if (running) callbacks.onLocalModelsDaemonStopRequested?.();
  else callbacks.onLocalModelsDaemonStartRequested?.();
}

function triggerCloudProvider(
  row: Extract<LlmPanelRow, { kind: "cloudProvider" }>,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (!row.available) {
    openProviderConfigFor(row.provider, dispatch);
    return;
  }
  callbacks.onProvidersSetActiveText?.(row.provider.id);
  stopLocalDaemonsForCloudSelection(state, callbacks);
}

function triggerLocalChatModel(
  model: LocalModelRow,
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  if (!model.downloaded) {
    callbacks.onLocalModelsPullRequested?.(model.id, "with-mmproj");
    return;
  }
  if (model.mmprojStatus === "missing") {
    callbacks.onLocalModelsPullRequested?.(model.id, "mmproj-only");
    return;
  }
  if (!model.active) callbacks.onLocalModelsSetActiveRequested?.(model.id);
  if (!isLocalTextActive(state)) {
    callbacks.onProvidersSetActiveText?.("local-llama");
  }
  const chatUp =
    state.localModelsPanel.daemon.running ||
    state.localModelsPanel.daemonPhase === "starting";
  if (model.active && !chatUp) callbacks.onLocalModelsDaemonStartRequested?.();
}

function triggerLocalEmbeddingModel(
  model: EmbeddingModelRow,
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  const daemon = state.localModelsPanel.embeddingDaemon;
  const localProviderActive = state.providersPanel.rows.some(
    (row) => row.id === "local-llama" && row.isActiveEmbedding,
  );
  if (!model.downloaded) {
    callbacks.onLocalModelsEmbeddingPullRequested?.(model.id);
    callbacks.onProvidersSetActiveEmbedding?.("local-llama");
    return;
  }
  if (!model.active) {
    callbacks.onLocalModelsEmbeddingSetActiveRequested?.(model.id);
    callbacks.onProvidersSetActiveEmbedding?.("local-llama");
    return;
  }
  if (!localProviderActive) callbacks.onProvidersSetActiveEmbedding?.("local-llama");
  if (!daemon?.enabled) {
    callbacks.onLocalModelsEmbeddingToggleEnabledRequested?.();
    return;
  }
  if (!daemon.running) callbacks.onLocalModelsEmbeddingStartRequested?.();
}

function triggerCloudChatModel(
  row: Extract<LlmPanelRow, { kind: "cloudChatModel" }>,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (!row.available) {
    openProviderConfigFor(row.provider, dispatch);
    return;
  }
  callbacks.onProvidersSelectChatModel?.(row.providerId, row.modelId);
  stopLocalDaemonsForCloudSelection(state, callbacks);
}

function triggerCloudEmbeddingModel(
  row: Extract<LlmPanelRow, { kind: "cloudEmbeddingModel" }>,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (!row.available) {
    openProviderConfigFor(row.provider, dispatch);
    return;
  }
  callbacks.onProvidersSelectEmbeddingModel?.(row.providerId, row.modelId);
  callbacks.onLocalModelsEmbeddingDisableRequested?.();
}

function openProviderConfigFor(
  provider: { id: string; kind: string; baseUrl?: string | null },
  dispatch: (action: TuiAction) => void,
): void {
  if (!isCloudProviderKind(provider.kind)) return;
  dispatch({ type: "providers_catalog_refresh_requested" });
  dispatch({
    type: "providers_wizard_opened",
    wizard: createProvidersWizardState("configure", {
      providerId: provider.id,
      kind: provider.kind,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    }),
  });
}

function stopLocalDaemonsForCloudSelection(
  state: TuiState,
  callbacks: TuiAppCallbacks,
): void {
  const localRunning =
    state.localModelsPanel.daemon.running ||
    state.localModelsPanel.daemonPhase === "starting";
  if (localRunning) {
    callbacks.onLocalModelsDaemonStopRequested?.();
  }
}
