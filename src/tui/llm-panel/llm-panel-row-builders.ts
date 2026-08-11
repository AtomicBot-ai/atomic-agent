import type {
  EmbeddingModelRow,
  LocalModelRow,
} from "../local-models/local-models-panel-state.js";
import { getCachedOpenAiCompatModelsForBaseUrl } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { filterModelIds, type ProviderRow } from "../providers/providers-panel-state.js";
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

/**
 * The inline "Cloud text models" section: the full filterable model
 * catalog of the active provider, rendered in place inside the Cloud
 * pane (between Cloud providers and Cloud embeddings). Replaces the
 * single current-model row + modal picker that pane used to open: the
 * list is complete, the `filter:` row narrows it, and the renderer
 * windows it to a dozen visible rows.
 */
export interface CloudModelSection {
  /** Provider whose models are listed (active text provider, or first cloud). */
  provider: ProviderRow | null;
  status: "loading" | "ready" | "error";
  /** Human-readable fetch error when `status === "error"`. */
  error: string | null;
  /** Full unfiltered catalog, current model first. */
  models: readonly string[];
  /** `models` narrowed by `llmPanel.cloudModelFilter`. */
  filtered: readonly string[];
  /** Flat-row index of the first model row (= cloud provider row count). */
  sectionStart: number;
}

export function selectCloudModelSection(state: TuiState): CloudModelSection {
  const providers = state.providersPanel.rows.filter(
    (row) => row.kind !== "llama-server",
  );
  const provider =
    providers.find((row) => row.isActiveText) ?? providers[0] ?? null;
  const sectionStart = providers.length;
  if (!provider) {
    return {
      provider: null,
      status: "ready",
      error: null,
      models: [],
      filtered: [],
      sectionStart,
    };
  }
  const catalog = inlineModelsForProvider(state, provider);
  const filtered = filterModelIds(
    catalog.models,
    state.llmPanel.cloudModelFilter,
  );
  return { provider, ...catalog, filtered, sectionStart };
}

export function selectCloudRows(state: TuiState): readonly LlmPanelRow[] {
  const providers = state.providersPanel.rows.filter(
    (row) => row.kind !== "llama-server",
  );
  const rows: LlmPanelRow[] = providers.map((provider) => cloudProviderRow(provider));
  const section = selectCloudModelSection(state);
  if (section.provider) {
    for (const modelId of section.filtered) {
      rows.push(cloudChatRow(section.provider, modelId));
    }
    for (const modelId of embeddingModelsForProvider(section.provider)) {
      rows.push(cloudEmbeddingRow(section.provider, modelId));
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

/**
 * Full chat-model list for a provider, current model first. Curated
 * kinds read their catalog synchronously. `openai-compatible` prefers
 * the orchestrator-owned inline catalog state (which carries live
 * loading/error transitions), then the 1h `/v1/models` module cache.
 * When neither has data yet the section reports `loading` — the fetch is
 * kicked by `ensureInlineModels` on tab activation and provider switch —
 * and only the current model shows as a fallback row. On `error` the
 * same single current-model row keeps the route selectable.
 */
function inlineModelsForProvider(
  state: TuiState,
  provider: ProviderRow,
): { models: readonly string[]; status: "loading" | "ready" | "error"; error: string | null } {
  const out = new Set<string>();
  for (const option of provider.chatModelOptions ?? []) out.add(option);
  if (provider.chatModel) out.add(provider.chatModel);
  if (provider.kind === "openrouter") {
    for (const option of listOpenRouterChatModels()) out.add(option.id);
    return { models: [...out], status: "ready", error: null };
  }
  if (provider.kind === "aimlapi") {
    for (const option of listAimlapiChatModels()) out.add(option.id);
    return { models: [...out], status: "ready", error: null };
  }
  // openai-compatible: live catalog state first, module cache second.
  const inline = state.providersPanel.inlineModels;
  if (inline && inline.providerId === provider.id) {
    if (inline.status === "ready") {
      for (const id of inline.models) out.add(id);
      return { models: [...out], status: "ready", error: null };
    }
    if (out.size === 0) out.add(OPENAI_COMPAT_DEFAULT_CHAT_MODEL);
    return { models: [...out], status: inline.status, error: inline.error };
  }
  const cached = provider.baseUrl
    ? getCachedOpenAiCompatModelsForBaseUrl(provider.baseUrl)
    : undefined;
  if (cached && cached.length > 0) {
    for (const id of cached) out.add(id);
    return { models: [...out], status: "ready", error: null };
  }
  if (out.size === 0) out.add(OPENAI_COMPAT_DEFAULT_CHAT_MODEL);
  return { models: [...out], status: "loading", error: null };
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
