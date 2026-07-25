import type { EmbeddingModelRow, LocalModelRow } from "../local-models/local-models-panel-state.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import type { TuiState } from "../tui-state.js";
import type { LlmPanelMode } from "./llm-panel-state.js";
import {
  selectCloudRows,
  selectExternalRows,
  selectLocalRows,
} from "./llm-panel-row-builders.js";
import { cursorFieldFor } from "./llm-panel-state.js";

export type LlmPanelRow =
  | {
      kind: "localTextModel";
      id: string;
      mode: "local";
      model: LocalModelRow;
      active: boolean;
      available: boolean;
      primaryAction: "download" | "download-mmproj" | "use" | "start" | "current";
      enterEffect: string;
    }
  | {
      kind: "localEmbeddingModel";
      id: string;
      mode: "local";
      model: EmbeddingModelRow;
      active: boolean;
      available: boolean;
      primaryAction: "download" | "use" | "enable" | "start" | "current";
      enterEffect: string;
    }
  | {
      /**
       * Call-to-action row pinned under the local text models: opens the
       * "add from Hugging Face" prompt. Carries no model — it is the one
       * row whose Enter creates a catalog entry rather than acting on one.
       */
      kind: "localAddHuggingFace";
      id: "local-add-huggingface";
      mode: "local";
      primaryAction: "add";
      enterEffect: string;
    }
  | {
      kind: "localDaemon";
      id: "local-runtime";
      mode: "local";
      primaryAction: "start" | "stop";
      enterEffect: string;
    }
  | {
      kind: "localBackend";
      id: "local-backend";
      mode: "local";
      primaryAction: "download";
      enterEffect: string;
    }
  | {
      kind: "cloudProvider";
      id: string;
      mode: "cloud";
      provider: ProviderRow;
      active: boolean;
      available: boolean;
      primaryAction: "configure" | "use" | "current";
      enterEffect: string;
    }
  | {
      kind: "cloudChatModel";
      id: string;
      mode: "cloud";
      provider: ProviderRow;
      providerId: string;
      modelId: string;
      active: boolean;
      available: boolean;
      primaryAction: "configure" | "use" | "current";
      enterEffect: string;
    }
  | {
      kind: "cloudEmbeddingModel";
      id: string;
      mode: "cloud";
      provider: ProviderRow;
      providerId: string;
      modelId: string;
      active: boolean;
      available: boolean;
      primaryAction: "configure" | "use" | "current";
      enterEffect: string;
    }
  | {
      kind: "externalUrl";
      id: "external-url";
      mode: "external";
      url: string;
      active: boolean;
      available: boolean;
      primaryAction: "edit" | "use" | "current";
      enterEffect: string;
    };

export interface LlmActiveRouteSummary {
  activeTextProvider: ProviderRow | null;
  activeEmbeddingProvider: ProviderRow | null;
  textModel: string | null;
  providerLabel: string;
  toolTransportLabel: string;
  cacheLabel: string;
  usesLocalHealth: boolean;
}

export interface PromptLlmMeta {
  model: string | null;
  provider: string | null;
  usesLocalHealth: boolean;
  cloudLabel: string | null;
}

export function selectLlmPanelRows(
  state: TuiState,
  mode: LlmPanelMode = state.llmPanel.mode,
): readonly LlmPanelRow[] {
  if (mode === "cloud") return selectCloudRows(state);
  if (mode === "external") return selectExternalRows(state);
  return selectLocalRows(state);
}

export function selectLlmRowAt(
  state: TuiState,
  cursor: number = activeCursor(state),
): LlmPanelRow | null {
  const rows = selectLlmPanelRows(state);
  if (rows.length === 0) return null;
  return rows[Math.min(Math.max(0, cursor), rows.length - 1)] ?? null;
}

export function clampLlmCursor(state: TuiState, cursor: number): number {
  const rows = selectLlmPanelRows(state);
  if (rows.length === 0) return 0;
  return Math.min(rows.length - 1, Math.max(0, cursor));
}

export function activeCursor(state: TuiState): number {
  return state.llmPanel[cursorFieldFor(state.llmPanel.mode)];
}

export function selectLlmActiveRouteSummary(
  state: TuiState,
): LlmActiveRouteSummary {
  const activeTextProvider =
    state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  const activeEmbeddingProvider =
    state.providersPanel.rows.find((row) => row.isActiveEmbedding) ?? null;
  const localActive = activeTextProvider?.kind === "llama-server";
  return {
    activeTextProvider,
    activeEmbeddingProvider,
    textModel:
      activeTextProvider?.chatModel ??
      activeTextProvider?.chatModelOptions?.[0] ??
      state.llmHealth.model,
    providerLabel: activeTextProvider?.id ?? "unknown",
    toolTransportLabel: localActive ? "grammar" : "native_tools",
    cacheLabel: localActive ? "local slot/cache_prompt" : "cloud: no slot affinity",
    usesLocalHealth: localActive || activeTextProvider === null,
  };
}

export function selectPromptLlmMeta(state: TuiState): PromptLlmMeta {
  const active = state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  if (active && active.kind !== "llama-server") {
    return {
      model: active.chatModel,
      provider: active.id,
      usesLocalHealth: false,
      cloudLabel: "cloud",
    };
  }
  return {
    model: state.llmHealth.model ?? active?.chatModel ?? null,
    provider: "llama.cpp",
    usesLocalHealth: true,
    cloudLabel: null,
  };
}

export function isLocalTextActive(state: TuiState): boolean {
  return state.providersPanel.rows.some(
    (row) => row.id === "local-llama" && row.isActiveText,
  );
}

