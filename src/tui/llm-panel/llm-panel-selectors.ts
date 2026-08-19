import type { EmbeddingModelRow, LocalModelRow } from "../local-models/local-models-panel-state.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import { runModeModelSummary } from "../run-mode/run-mode-selectors.js";
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
      primaryAction:
        | "download"
        | "downloading"
        | "download-mmproj"
        | "use"
        | "start"
        | "current";
      enterEffect: string;
    }
  | {
      kind: "localEmbeddingModel";
      id: string;
      mode: "local";
      model: EmbeddingModelRow;
      active: boolean;
      available: boolean;
      primaryAction:
        | "download"
        | "downloading"
        | "use"
        | "enable"
        | "start"
        | "current";
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
  // The Fallback pane renders from `state.fallbackPanel`, not from the
  // shared `LlmPanelRow` list — it has no rows in this model.
  if (mode === "fallback") return [];
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

/**
 * What the composer's meta row names as the route for the next turn.
 *
 * Fusion is read off the run-mode mirror rather than the active provider
 * because it is the one mode whose route is a PAIR. The fusion rule puts
 * the cloud leg in `activeTextProvider`, so following the active row
 * alone would print the same single cloud model for Cloud and for
 * Fusion — the composer would not move at all on a switch between them,
 * and it would never name the local executor that runs most of the
 * steps. `activeTextProvider` stays authoritative: `effective` is only
 * ever `fusion` when that provider IS the cloud leg, so this reports the
 * resolution, it does not compete with it.
 */
export function selectPromptLlmMeta(state: TuiState): PromptLlmMeta {
  const active = state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  const runMode = state.runModePanel;
  const fusionPair =
    runMode.effective === "fusion" ? runModeModelSummary(runMode) : null;
  if (fusionPair) {
    return {
      model: fusionPair,
      provider: runMode.cloudProviderId,
      usesLocalHealth: false,
      cloudLabel: "fusion",
    };
  }
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

