import {
  cloudChatRow,
  cloudProviderRow,
  selectCloudModelSection,
  selectLocalRows,
} from "../llm-panel/llm-panel-row-builders.js";
import type { LlmHealthStatus } from "../llm-health/llm-health-state.js";
import type { LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import type { TuiState } from "../tui-state.js";
import { filterSwitchRows } from "./composer-switch-filter.js";
import {
  COMPOSER_SWITCH_TITLES,
  type ComposerBackendKind,
  type ComposerSwitchKind,
} from "./composer-switch-state.js";

/**
 * What activating a row does. `llmRow` is the important one: it carries
 * a real `LlmPanelRow`, so the composer's switches select a provider or
 * a model through `triggerLlmPrimary` — the same call the LLM tab makes
 * — instead of growing a second switching implementation next to
 * `ProvidersOrchestrator`.
 */
export type ComposerSwitchIntent =
  | { readonly kind: "backend"; readonly backend: ComposerBackendKind }
  | { readonly kind: "llmRow"; readonly row: LlmPanelRow }
  | { readonly kind: "addProvider" }
  /**
   * Deep link to Manage › LLM › Local — the pane where models are
   * downloaded. The local model switch lists only what is on disk, so
   * this row is its way of saying "more exists than you see here".
   */
  | { readonly kind: "localModelsPanel" };

export interface ComposerSwitchRow {
  readonly id: string;
  readonly label: string;
  /** Second column: what choosing this row would mean. */
  readonly detail: string;
  readonly active: boolean;
  readonly intent: ComposerSwitchIntent;
}

/**
 * Which of the three backends the chat route is on right now.
 *
 * `local` and `custom` are the same provider entry (`local-llama`); the
 * config tells them apart by `localModels.mode`, mirrored onto the panel
 * as `configMode`. A route with no active provider at all reads as the
 * local one, matching `selectPromptLlmMeta`.
 */
export function selectComposerBackend(state: TuiState): ComposerBackendKind {
  const active =
    state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  if (active && active.kind !== "llama-server") return "cloud";
  return state.localModelsPanel.configMode === "external" ? "custom" : "local";
}

export interface ComposerBackendMeta {
  readonly kind: ComposerBackendKind;
  /**
   * The dot drawn in front of the backend word, in the vocabulary
   * `llm-health-badge.tsx` owns.
   */
  readonly status: LlmHealthStatus;
}

/**
 * What the backend control renders.
 *
 * Cloud reports `healthy` because there is no probe behind it — the
 * composer has always drawn a green dot for a cloud route, and inventing
 * an `unknown` here would read as a fault where none was observed. Local
 * and custom carry the real llama-server probe, and stay `unknown` until
 * a local backend is actually the route (`localConfigured`), so a fresh
 * install does not announce that a server nobody configured is down.
 */
export function selectComposerBackendMeta(state: TuiState): ComposerBackendMeta {
  const kind = selectComposerBackend(state);
  if (kind === "cloud") return { kind, status: "healthy" };
  return {
    kind,
    status: state.llmHealth.localConfigured ? state.llmHealth.status : "unknown",
  };
}

/** Cloud providers the operator has actually added, in config order. */
function configuredCloudProviders(state: TuiState) {
  return state.providersPanel.rows.filter((row) => row.kind !== "llama-server");
}

function backendRows(state: TuiState): readonly ComposerSwitchRow[] {
  const current = selectComposerBackend(state);
  const cloud = configuredCloudProviders(state);
  const ready = cloud.filter((row) => row.hasApiKey);
  return [
    {
      id: "backend:cloud",
      label: "cloud",
      detail:
        ready.length > 0
          ? `${ready.length} provider${ready.length === 1 ? "" : "s"} ready`
          : "add a provider first",
      active: current === "cloud",
      intent: { kind: "backend", backend: "cloud" },
    },
    {
      id: "backend:local",
      label: "local",
      detail: "llama.cpp managed here",
      active: current === "local",
      intent: { kind: "backend", backend: "local" },
    },
    {
      id: "backend:custom",
      label: "custom",
      detail: `llama.cpp you run · ${state.session.llamaUrl}`,
      active: current === "custom",
      intent: { kind: "backend", backend: "custom" },
    },
  ];
}

function providerRows(state: TuiState): readonly ComposerSwitchRow[] {
  const rows = configuredCloudProviders(state).map((provider) => ({
    id: `provider:${provider.id}`,
    label: provider.id,
    detail: provider.hasApiKey
      ? (provider.chatModel ?? "default model")
      : "no API key",
    active: provider.isActiveText,
    intent: { kind: "llmRow" as const, row: cloudProviderRow(provider) },
  }));
  return [
    ...rows,
    {
      id: "provider:add",
      label: "Add a new provider",
      detail: "opens the wizard",
      active: false,
      intent: { kind: "addProvider" as const },
    },
  ];
}

/**
 * The chat models of whatever is serving the route: the active cloud
 * provider's catalog, or the local models on disk. Unfiltered on
 * purpose — the Cloud pane's `filter:` box is that pane's state, and a
 * filter left typed there must not silently shorten this list.
 */
function modelRows(state: TuiState): readonly ComposerSwitchRow[] {
  const backend = selectComposerBackend(state);
  if (backend === "cloud") {
    const section = selectCloudModelSection(state);
    const provider = section.provider;
    if (!provider) return [];
    return section.models.map((modelId) => ({
      id: `model:${provider.id}:${modelId}`,
      label: modelId,
      detail: section.status === "loading" ? "loading…" : "",
      active: provider.isActiveText && provider.chatModel === modelId,
      intent: { kind: "llmRow" as const, row: cloudChatRow(provider, modelId) },
    }));
  }
  if (backend === "local") {
    // Only what is on disk: a catalog row here would put a
    // multi-gigabyte download one Enter away from "switch model". The
    // catalog stays reachable through the deep-link row instead.
    const downloaded = selectLocalRows(state)
      .filter((row) => row.kind === "localTextModel")
      .filter((row) => row.model.downloaded)
      .map((row) => ({
        id: `model:local:${row.model.id}`,
        label: row.model.id,
        detail: "",
        active: row.active,
        intent: { kind: "llmRow" as const, row },
      }));
    return [
      ...localSliceLoadingRows(state),
      ...downloaded,
      {
        id: "model:local:download-more",
        label: "Download more models…",
        detail: "opens the local models pane",
        active: false,
        intent: { kind: "localModelsPanel" as const },
      },
    ];
  }
  return [
    ...localSliceLoadingRows(state),
    ...selectLocalRows(state)
      .filter((row) => row.kind === "localTextModel")
      .map((row) => ({
        id: `model:local:${row.model.id}`,
        label: row.model.id,
        detail: row.model.downloaded ? "" : "not downloaded",
        active: row.active,
        intent: { kind: "llmRow" as const, row },
      })),
  ];
}

/**
 * One "loading…" row until the first local-models snapshot lands. The
 * slice is refreshed by the Models/LLM tab's loop and, since the switch
 * must be truthful from anywhere, by the switch-open effect in
 * `tui-app.tsx` — but right after boot `rows` is still empty even with
 * models on disk, and an empty list here would read as "nothing
 * downloaded". Enter on the row deep-links to the pane the list lives
 * in, same as the download row.
 */
function localSliceLoadingRows(
  state: TuiState,
): readonly ComposerSwitchRow[] {
  const panel = state.localModelsPanel;
  if (panel.lastRefreshedAt !== null || panel.rows.length > 0) return [];
  return [
    {
      id: "model:local:loading",
      label: "loading…",
      detail: "reading what is on disk",
      active: false,
      intent: { kind: "localModelsPanel" as const },
    },
  ];
}

export function selectComposerSwitchRows(
  state: TuiState,
  kind: ComposerSwitchKind,
): readonly ComposerSwitchRow[] {
  const rows =
    kind === "backend"
      ? backendRows(state)
      : kind === "provider"
        ? providerRows(state)
        : modelRows(state);
  const open = state.composerSwitch;
  // The typed filter is applied here, not in the renderer: cursor
  // clamping, Enter and the popup must all see the same narrowed list,
  // or the row picked would not be the row highlighted.
  if (!open || open.kind !== kind) return rows;
  return filterSwitchRows(rows, open.filter);
}

/** Row the cursor sits on, or `null` when the switch has no rows at all. */
export function selectComposerSwitchRow(
  state: TuiState,
): ComposerSwitchRow | null {
  const open = state.composerSwitch;
  if (!open) return null;
  const rows = selectComposerSwitchRows(state, open.kind);
  return rows[clampComposerSwitchCursor(state, open.cursor)] ?? null;
}

export function clampComposerSwitchCursor(
  state: TuiState,
  cursor: number,
): number {
  const open = state.composerSwitch;
  if (!open) return 0;
  const rows = selectComposerSwitchRows(state, open.kind);
  if (rows.length === 0) return 0;
  return Math.min(rows.length - 1, Math.max(0, cursor));
}

/** Row a freshly opened switch lands on: the one already in effect. */
export function initialComposerSwitchCursor(
  state: TuiState,
  kind: ComposerSwitchKind,
): number {
  const rows = selectComposerSwitchRows(state, kind);
  const at = rows.findIndex((row) => row.active);
  return at < 0 ? 0 : at;
}

export function selectComposerSwitchTitle(kind: ComposerSwitchKind): string {
  return COMPOSER_SWITCH_TITLES[kind];
}
