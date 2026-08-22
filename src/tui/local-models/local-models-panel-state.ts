import type {
  EmbeddingModelDef,
  EmbeddingModelId,
  LocalModelDef,
  LocalModelId,
} from "../../local-llm/index.js";

export type LocalModelsPanelMode = "list" | "detail" | "backendUpdate" | "pullProgress";

/**
 * Memory-v2 phase 1B (revised). The panel renders chat and embedding
 * catalogs on a **single screen** with one shared cursor. Indices
 * `[0..rows.length-1]` are chat rows; indices
 * `[rows.length..rows.length+embeddingRows.length-1]` are embedding
 * rows. `resolveRowAt(panel, idx)` is the single source of truth for
 * "which row is under the cursor right now". This replaces the older
 * `catalogView` toggle which forced operators to flip a hidden mode
 * just to see what was on disk.
 */
export type LocalModelsRowRef =
  | { kind: "chat"; row: LocalModelRow; index: number }
  | { kind: "embedding"; row: EmbeddingModelRow; index: number };

/**
 * mmproj projector status — surfaced as a separate dimension from the
 * GGUF download flag because vision-capable models require both files
 * to be on disk before `vision.describe` can run.
 *
 * - `n/a`        — model is not vision-capable (`def.supportsVision === false`).
 * - `missing`    — vision-capable model whose projector is not yet on disk.
 * - `downloaded` — projector is present.
 */
export type MmprojStatus = "n/a" | "missing" | "downloaded";

export interface LocalModelRow {
  id: LocalModelId;
  def: LocalModelDef;
  downloaded: boolean;
  active: boolean;
  /**
   * Independent of `downloaded` — a vision-capable model can have its
   * GGUF on disk while the mmproj projector is still missing (and vice
   * versa, although less common).
   */
  mmprojStatus: MmprojStatus;
}

export interface LocalModelsPullState {
  kind: "chat" | "embedding" | "backend";
  modelId: LocalModelId | EmbeddingModelId | "_backend";
  label: string;
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  error: string | null;
}

/**
 * Memory-v2 phase 1B. One row per `EmbeddingModelDef`. Mirrors
 * `LocalModelRow` but without the mmproj dimension (embedding models
 * are text-only).
 */
export interface EmbeddingModelRow {
  id: EmbeddingModelId;
  def: EmbeddingModelDef;
  downloaded: boolean;
  /** Currently selected in `localModels.embeddings.modelId`. */
  active: boolean;
}

/**
 * Memory-v2 phase 1B. Status snapshot for the embedding daemon
 * (secondary `llama-server --embeddings`). `null` while the feature
 * is disabled — the daemon is not just stopped, it isn't supposed to
 * run at all. The CLI / config-wizard surfaces the flag separately
 * from start/stop.
 */
export interface EmbeddingDaemonInfo {
  enabled: boolean;
  running: boolean;
  healthy: boolean;
  loading: boolean;
  pid: number | null;
  port: number;
  /** `null` when no embedding model is configured. */
  activeModelId: EmbeddingModelId | null;
}

export interface LocalModelsBackendInfo {
  currentTag: string | null;
  latestTag: string | null;
  updateAvailable: boolean | null;
  /** `localModels.managed.autoUpdate`; surfaced so `U` has visible state. */
  autoUpdate: boolean;
}

export interface LocalModelsDaemonInfo {
  running: boolean;
  healthy: boolean;
  loading: boolean;
  pid: number | null;
  port: number;
}

/**
 * User-initiated daemon operation in flight. The snapshot-level
 * `daemon.running/healthy/loading` still drives the final rendered state,
 * but this phase lets the UI show "starting…" immediately after the user
 * presses a key, before the health probe catches up on the next refresh.
 */
export type DaemonPhase = "idle" | "starting" | "stopping";

export interface LocalModelsPanelState {
  mode: LocalModelsPanelMode;
  rows: readonly LocalModelRow[];
  cursor: number;
  backend: LocalModelsBackendInfo;
  daemon: LocalModelsDaemonInfo;
  daemonPhase: DaemonPhase;
  /** Sticky error from the last start/stop attempt. Cleared on next attempt. */
  daemonError: string | null;
  configMode: "external" | "managed";
  activeModelId: LocalModelId | null;
  pull: LocalModelsPullState | null;
  embeddingPull: LocalModelsPullState | null;
  lastRefreshedAt: number | null;
  loading: boolean;
  errorLine: string | null;
  removeConfirmId: LocalModelId | null;
  /**
   * Absolute path to the local models data directory — surfaced so the
   * UI can show where backend + GGUF files actually land on disk.
   */
  dataDir: string | null;
  /**
   * Total physical RAM reported by `os.totalmem()` rounded to whole GB
   * (decimal). `null` until the first snapshot lands. Used by the list
   * view to flag models whose `minRamGb` / `recommendedRamGb` exceed
   * what the host can realistically load.
   */
  totalRamGb: number | null;
  /**
   * GPU memory budget (decimal GB) the active model would have to fit
   * into: unified-memory fraction on macOS, discrete VRAM of the chosen
   * device on Linux/Windows. `null` when there is no meaningful budget
   * to compare against (external mode / CPU-forced / no GPU / unknown),
   * in which case the VRAM badge is suppressed.
   */
  gpuBudgetGb: number | null;
  /** Rows for the embedding catalog. Empty while the snapshot has not landed. */
  embeddingRows: readonly EmbeddingModelRow[];
  /** Embedding daemon snapshot. `null` until the first refresh resolves. */
  embeddingDaemon: EmbeddingDaemonInfo | null;
  /**
   * Sticky removal-confirmation modal for the embedding catalog. Kept
   * separate from `removeConfirmId` so the typed `LocalModelId` vs
   * `EmbeddingModelId` union never collapses into `string`.
   */
  embeddingRemoveConfirmId: EmbeddingModelId | null;
  /**
   * Memory-v2 phase 1B onboarding. After a successful chat-model pull
   * the orchestrator emits a yes/no prompt offering to fetch the
   * default embedding model in the same flow. `null` means no prompt
   * is currently visible. Cleared on dismiss / accept.
   *
   *  - `modelId`   — suggested embedding model (catalog default).
   *  - `name`      — friendly label for the modal.
   *  - `sizeLabel` — pre-formatted size hint (`"~84 MB"`) for the modal.
   */
  embeddingOnboardingPrompt: {
    modelId: EmbeddingModelId;
    name: string;
    sizeLabel: string;
  } | null;
}

/**
 * Resolve which row sits under the combined cursor. Returns `null`
 * when the cursor is out of range (typically only during the first
 * render before the snapshot lands). Stable across renders so the
 * key-binding layer and the panel component agree on row identity.
 */
export function resolveRowAt(
  panel: LocalModelsPanelState,
  idx: number = panel.cursor,
): LocalModelsRowRef | null {
  if (idx < 0) return null;
  if (idx < panel.rows.length) {
    return { kind: "chat", row: panel.rows[idx]!, index: idx };
  }
  const embIdx = idx - panel.rows.length;
  if (embIdx < panel.embeddingRows.length) {
    return {
      kind: "embedding",
      row: panel.embeddingRows[embIdx]!,
      index: embIdx,
    };
  }
  return null;
}

/** Total combined row count for cursor clamping. */
export function totalRowCount(panel: LocalModelsPanelState): number {
  return panel.rows.length + panel.embeddingRows.length;
}

/**
 * Config-derived facts worth knowing before the first snapshot. The
 * orchestrator only refreshes this slice while the Models tab is open,
 * but the composer's route controls render on the *home* screen from
 * frame one — unseeded, a managed install reads `custom` and shows no
 * chosen model until the operator happens to visit the tab once.
 */
export interface LocalModelsPanelSeed {
  configMode: LocalModelsPanelState["configMode"];
  activeModelId: LocalModelsPanelState["activeModelId"];
}

export function createInitialLocalModelsPanelState(
  seed?: LocalModelsPanelSeed,
): LocalModelsPanelState {
  return {
    mode: "list",
    rows: [],
    cursor: 0,
    backend: {
      currentTag: null,
      latestTag: null,
      updateAvailable: null,
      autoUpdate: true,
    },
    daemon: {
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19091,
    },
    daemonPhase: "idle",
    daemonError: null,
    configMode: seed?.configMode ?? "external",
    activeModelId: seed?.activeModelId ?? null,
    pull: null,
    embeddingPull: null,
    lastRefreshedAt: null,
    loading: false,
    errorLine: null,
    removeConfirmId: null,
    dataDir: null,
    totalRamGb: null,
    gpuBudgetGb: null,
    embeddingRows: [],
    embeddingDaemon: null,
    embeddingRemoveConfirmId: null,
    embeddingOnboardingPrompt: null,
  };
}

export type RamFit = "ok" | "tight" | "insufficient";

/**
 * Classify a model against the detected host RAM. `null` means RAM is
 * not yet known (first snapshot pending) — the UI then suppresses the
 * indicator so we don't flash a spurious red badge during boot.
 */
export function classifyRamFit(
  def: LocalModelDef,
  totalRamGb: number | null,
): RamFit | null {
  if (totalRamGb === null) return null;
  if (totalRamGb < def.minRamGb) return "insufficient";
  if (totalRamGb < def.recommendedRamGb) return "tight";
  return "ok";
}

/**
 * Headroom multiplier on the raw GGUF weight size to approximate the
 * runtime GPU memory footprint (KV-cache, compute buffers, projector).
 * Deliberately coarse — the badge only needs to catch the clear "won't
 * fit" cases, not predict the exact allocation.
 */
export const MODEL_VRAM_HEADROOM = 1.2;

/**
 * Estimated GPU memory (decimal GB) a chat model needs to load fully:
 * the GGUF weight size plus a fixed headroom factor.
 */
export function estimateModelVramNeedGb(def: LocalModelDef): number {
  return def.fileSizeGb * MODEL_VRAM_HEADROOM;
}

export type VramFit = "ok" | "insufficient";

/**
 * Classify a model against the detected GPU memory budget. `null` means
 * the budget is not known (external mode / CPU-forced / no GPU / first
 * snapshot pending) — the UI then suppresses the VRAM badge entirely.
 * Mirrors `classifyRamFit` but binary: only the negative case is
 * surfaced to the operator.
 */
export function classifyVramFit(
  def: LocalModelDef,
  gpuBudgetGb: number | null,
): VramFit | null {
  if (gpuBudgetGb === null) return null;
  return estimateModelVramNeedGb(def) > gpuBudgetGb ? "insufficient" : "ok";
}
