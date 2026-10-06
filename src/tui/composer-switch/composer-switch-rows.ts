export type {
  ComposerSwitchIntent,
  ComposerSwitchRow,
} from "./composer-switch-row-contracts.js";
import {
  configuredCloudProviders,
  localSliceLoadingRows,
  type ComposerSwitchRow,
} from "./composer-switch-row-contracts.js";
import {
  cloudChatRow,
  cloudProviderRow,
  selectCloudModelSection,
  selectLocalRows,
} from "../llm-panel/llm-panel-row-builders.js";
import type { TuiState } from "../tui-state.js";
import { describeFusionBlocker } from "../run-mode/fusion-preflight.js";
import { selectComposerBackend } from "./composer-backend-selectors.js";
import { selectWorkerRows } from "./composer-switch-worker-rows.js";
import { filterSwitchRows } from "./composer-switch-filter.js";
import {
  COMPOSER_SWITCH_TITLES,
  type ComposerBackendKind,
  type ComposerSwitchKind,
} from "./composer-switch-state.js";

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
    // Last on purpose: the three above are routes, this one is a mode
    // built on two of them, and a reader scanning down meets the parts
    // before the composition.
    {
      id: "backend:fusion",
      label: "fusion",
      detail: describeFusionBlocker(state) ?? fusionDetail(state),
      active: current === "fusion",
      intent: { kind: "backend", backend: "fusion" },
      emphasis: "fusion",
    },
  ];
}

function fusionDetail(state: TuiState): string {
  const workers = state.providersPanel.runMode?.workers ?? 2;
  return `cloud plans · ${workers} local worker${workers === 1 ? "" : "s"}`;
}

/**
 * The backend row for `kind`, as the popup would list it. `/runmode
 * <mode>` and the `ctrl+g 1/2/3` chords activate exactly this row, so
 * every route to a run mode shares one activation path and one
 * pre-flight.
 */
export function backendSwitchRow(
  state: TuiState,
  backend: ComposerBackendKind,
): ComposerSwitchRow {
  const row = backendRows(state).find(
    (candidate) =>
      candidate.intent.kind === "backend" &&
      candidate.intent.backend === backend,
  );
  if (!row) throw new Error(`no backend row for ${backend}`);
  return row;
}

function providerRows(state: TuiState): readonly ComposerSwitchRow[] {
  const runMode = state.providersPanel.runMode;
  const fusion = runMode?.effective === "fusion";
  const rows = configuredCloudProviders(state).map((provider) => ({
    id: `provider:${provider.id}`,
    label: provider.id,
    detail: fusion
      ? provider.hasApiKey
        ? "orchestrator"
        : "no API key"
      : provider.hasApiKey
        ? (provider.chatModel ?? "default model")
        : "no API key",
    active: fusion
      ? provider.id === runMode?.orchestratorProviderId
      : provider.isActiveText,
    intent: { kind: "llmRow" as const, row: cloudProviderRow(provider) },
  }));
  // Under fusion this control is the ORCHESTRATOR slot, and a local
  // model is allowed to hold it: cheap planning driving capable cloud
  // executors is a pairing worth having. Off fusion the row would be a
  // duplicate of the `local` backend route, so it is only drawn here.
  const localLeg: ComposerSwitchRow[] =
    fusion && state.localModelsPanel.rows.some((row) => row.downloaded)
      ? [
          {
            id: "provider:local-llama",
            label: "local-llama",
            detail: "orchestrator · runs on this machine",
            active: runMode?.orchestratorProviderId === "local-llama",
            intent: {
              kind: "fusionLeg" as const,
              leg: "orchestrator" as const,
              providerId: "local-llama",
            },
          },
        ]
      : [];
  return [
    ...rows,
    ...localLeg,
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
  // Under fusion the model control addresses the orchestrator leg — the
  // active cloud provider — so its rows are the cloud rows.
  if (backend === "cloud" || backend === "fusion") {
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

export function selectComposerSwitchRows(
  state: TuiState,
  kind: ComposerSwitchKind,
): readonly ComposerSwitchRow[] {
  const rows =
    kind === "backend"
      ? backendRows(state)
      : kind === "provider"
        ? providerRows(state)
        : kind === "workers"
          ? selectWorkerRows(state)
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
