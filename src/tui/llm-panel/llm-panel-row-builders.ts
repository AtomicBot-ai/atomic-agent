import type {
  EmbeddingModelRow,
  LocalModelRow,
} from "../local-models/local-models-panel-state.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import {
  formatAimlapiChatModelDetails,
  formatAimlapiEmbeddingModelDetails,
  formatOpenRouterChatModelDetails,
  formatOpenRouterEmbeddingModelDetails,
  listAimlapiChatModels,
  listAimlapiEmbeddingModels,
  listOpenRouterEmbeddingModels,
  listOpenRouterChatModels,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "../providers/providers-model-options.js";
import type { TuiState } from "../tui-state.js";
import type { LlmPanelRow } from "./llm-panel-selectors.js";

export function selectLocalRows(state: TuiState): readonly LlmPanelRow[] {
  const rows: LlmPanelRow[] = [];
  for (const model of state.localModelsPanel.rows) rows.push(localTextRow(state, model));
  for (const model of state.localModelsPanel.embeddingRows) {
    rows.push(localEmbeddingRow(state, model));
  }
  return rows;
}

/**
 * The External pane is a single row: an external llama.cpp *is* one base
 * URL. Enter opens the editor pre-filled with the current URL; saving it
 * is what flips `localModels.mode` to `external` (see
 * `persistUserLocalLlmUrl`), so there is no separate "switch" action.
 */
export function selectExternalRows(state: TuiState): readonly LlmPanelRow[] {
  const active =
    state.localModelsPanel.configMode === "external" &&
    state.providersPanel.rows.some(
      (row) => row.id === "local-llama" && row.isActiveText,
    );
  return [
    {
      kind: "externalUrl",
      id: "external-url",
      mode: "external",
      url: state.session.llamaUrl,
      active,
      available: true,
      primaryAction: active ? "current" : "use",
      enterEffect: active
        ? "Enter: edit the base URL"
        : "Enter: point the chat route at an external llama.cpp",
    },
  ];
}

export function selectCloudRows(state: TuiState): readonly LlmPanelRow[] {
  const providers = state.providersPanel.rows.filter(
    (row) => row.kind !== "llama-server",
  );
  const activeProvider =
    providers.find((row) => row.isActiveText) ?? providers[0] ?? null;
  const rows: LlmPanelRow[] = providers.map((provider) => cloudProviderRow(provider));
  if (activeProvider) {
    for (const modelId of chatModelsForProvider(activeProvider)) {
      rows.push(cloudChatRow(activeProvider, modelId));
    }
    for (const modelId of embeddingModelsForProvider(activeProvider)) {
      rows.push(cloudEmbeddingRow(activeProvider, modelId));
    }
  }
  return rows;
}

function localTextRow(state: TuiState, model: LocalModelRow): LlmPanelRow {
  const localActive = state.providersPanel.rows.some(
    (row) => row.id === "local-llama" && row.isActiveText,
  );
  const daemonWorks = state.localModelsPanel.daemon.healthy;
  const active = localActive && model.active && daemonWorks;
  if (!model.downloaded) {
    return buildLocalTextRow(model, active, false, "download", "Enter: download");
  }
  if (model.def.supportsVision && model.mmprojStatus === "missing") {
    return buildLocalTextRow(
      model,
      active,
      false,
      "download-mmproj",
      `Enter: download projector for ${model.id}`,
    );
  }
  if (!localActive || !model.active) {
    return buildLocalTextRow(model, active, true, "use", `Enter: use local-llama/${model.id}`);
  }
  const running =
    state.localModelsPanel.daemon.running ||
    state.localModelsPanel.daemonPhase === "starting";
  return buildLocalTextRow(
    model,
    active,
    true,
    running ? "current" : "start",
    running ? `Current: local-llama/${model.id}` : `Enter: start local daemon for ${model.id}`,
  );
}

function buildLocalTextRow(
  model: LocalModelRow,
  active: boolean,
  available: boolean,
  primaryAction: Extract<LlmPanelRow, { kind: "localTextModel" }>["primaryAction"],
  enterEffect: string,
): LlmPanelRow {
  return {
    kind: "localTextModel",
    id: `local-text:${model.id}`,
    mode: "local",
    model,
    active,
    available,
    primaryAction,
    enterEffect,
  };
}

function localEmbeddingRow(state: TuiState, model: EmbeddingModelRow): LlmPanelRow {
  const daemon = state.localModelsPanel.embeddingDaemon;
  const localEmbeddingActive = state.providersPanel.rows.some(
    (row) => row.id === "local-llama" && row.isActiveEmbedding,
  );
  const daemonWorks = Boolean(daemon?.running && daemon.healthy);
  const active = localEmbeddingActive && model.active && daemonWorks;
  if (!model.downloaded) {
    return buildLocalEmbeddingRow(
      model,
      active,
      false,
      "download",
      "Enter: download",
    );
  }
  if (!localEmbeddingActive || !model.active) {
    return buildLocalEmbeddingRow(
      model,
      active,
      true,
      "use",
      `Enter: use local embedding ${model.id}`,
    );
  }
  if (!daemon?.enabled) {
    return buildLocalEmbeddingRow(
      model,
      active,
      true,
      "enable",
      `Enter: enable local embeddings for ${model.id}`,
    );
  }
  return buildLocalEmbeddingRow(
    model,
    active,
    true,
    daemonWorks ? "current" : "start",
    daemonWorks
      ? `Current: local embeddings/${model.id}`
      : `Enter: start embedding daemon for ${model.id}`,
  );
}

function buildLocalEmbeddingRow(
  model: EmbeddingModelRow,
  active: boolean,
  available: boolean,
  primaryAction: Extract<LlmPanelRow, { kind: "localEmbeddingModel" }>["primaryAction"],
  enterEffect: string,
): LlmPanelRow {
  return {
    kind: "localEmbeddingModel",
    id: `local-embedding:${model.id}`,
    mode: "local",
    model,
    active,
    available,
    primaryAction,
    enterEffect,
  };
}

function cloudProviderRow(provider: ProviderRow): LlmPanelRow {
  if (!provider.hasApiKey) {
    return {
      kind: "cloudProvider",
      id: `cloud-provider:${provider.id}`,
      mode: "cloud",
      provider,
      active: provider.isActiveText,
      available: false,
      primaryAction: "configure",
      enterEffect: `Enter: configure API key for ${provider.id}`,
    };
  }
  return {
    kind: "cloudProvider",
    id: `cloud-provider:${provider.id}`,
    mode: "cloud",
    provider,
    active: provider.isActiveText,
    available: true,
    primaryAction: provider.isActiveText ? "current" : "use",
    enterEffect: provider.isActiveText
      ? `Current provider: ${provider.id}`
      : `Enter: switch cloud route to ${provider.id}`,
  };
}

function cloudChatRow(provider: ProviderRow, modelId: string): LlmPanelRow {
  const active = provider.isActiveText && provider.chatModel === modelId;
  return {
    kind: "cloudChatModel",
    id: `cloud-text:${provider.id}:${modelId}`,
    mode: "cloud",
    provider,
    providerId: provider.id,
    modelId,
    active,
    available: provider.hasApiKey,
    primaryAction: provider.hasApiKey ? (active ? "current" : "use") : "configure",
    enterEffect: cloudChatEnterEffect(provider, modelId, active),
  };
}

function cloudEmbeddingRow(provider: ProviderRow, modelId: string): LlmPanelRow {
  const active = provider.isActiveEmbedding && provider.embeddingModel === modelId;
  return {
    kind: "cloudEmbeddingModel",
    id: `cloud-embedding:${provider.id}:${modelId}`,
    mode: "cloud",
    provider,
    providerId: provider.id,
    modelId,
    active,
    available: provider.hasApiKey,
    primaryAction: provider.hasApiKey ? (active ? "current" : "use") : "configure",
    enterEffect: cloudEmbeddingEnterEffect(provider, modelId, active),
  };
}

function cloudChatEnterEffect(
  provider: ProviderRow,
  modelId: string,
  active: boolean,
): string {
  if (!provider.hasApiKey) return `Enter: configure ${provider.id} before using ${modelId}`;
  if (provider.kind === "openrouter") {
    const details = formatOpenRouterChatModelDetails(modelId);
    return active ? `Current · ${details}` : details;
  }
  if (provider.kind === "aimlapi") {
    const details = formatAimlapiChatModelDetails(modelId);
    return active ? `Current · ${details}` : details;
  }
  return active ? `Current: ${provider.id}/${modelId}` : `Enter: use ${provider.id}/${modelId}`;
}

function cloudEmbeddingEnterEffect(
  provider: ProviderRow,
  modelId: string,
  active: boolean,
): string {
  if (!provider.hasApiKey) return `Enter: configure ${provider.id} before using embeddings`;
  if (provider.kind === "openrouter") {
    const details = formatOpenRouterEmbeddingModelDetails(modelId);
    return active ? `Current embedding · ${details}` : details;
  }
  if (provider.kind === "aimlapi") {
    const details = formatAimlapiEmbeddingModelDetails(modelId);
    return active ? `Current embedding · ${details}` : details;
  }
  return active
    ? `Current embedding: ${provider.id}/${modelId}`
    : `Enter: use embedding ${provider.id}/${modelId}`;
}

function chatModelsForProvider(provider: ProviderRow): readonly string[] {
  const out = new Set<string>();
  for (const option of provider.chatModelOptions ?? []) out.add(option);
  if (provider.chatModel) out.add(provider.chatModel);
  if (provider.kind === "openrouter") {
    for (const option of listOpenRouterChatModels()) out.add(option.id);
  } else if (provider.kind === "aimlapi") {
    for (const option of listAimlapiChatModels()) out.add(option.id);
  } else if (provider.kind === "openai-compatible" && out.size === 0) {
    out.add(OPENAI_COMPAT_DEFAULT_CHAT_MODEL);
  }
  return [...out];
}

function embeddingModelsForProvider(provider: ProviderRow): readonly string[] {
  const out = new Set<string>();
  if (provider.embeddingModel) out.add(provider.embeddingModel);
  if (provider.kind === "openrouter") {
    for (const option of listOpenRouterEmbeddingModels()) {
      if (option.id !== "__local_embedding__") out.add(option.id);
    }
  } else if (provider.kind === "aimlapi") {
    for (const option of listAimlapiEmbeddingModels()) {
      if (option.id !== "__local_embedding__") out.add(option.id);
    }
  }
  return [...out];
}
