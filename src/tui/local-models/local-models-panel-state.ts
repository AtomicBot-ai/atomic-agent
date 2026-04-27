import type { LocalModelDef, LocalModelId } from "../../local-llm/index.js";

export type LocalModelsPanelMode = "list" | "detail" | "backendUpdate" | "pullProgress";

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
  modelId: LocalModelId | "_backend";
  label: string;
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  error: string | null;
}

export interface LocalModelsBackendInfo {
  currentTag: string | null;
  latestTag: string | null;
  updateAvailable: boolean | null;
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
}

export function createInitialLocalModelsPanelState(): LocalModelsPanelState {
  return {
    mode: "list",
    rows: [],
    cursor: 0,
    backend: { currentTag: null, latestTag: null, updateAvailable: null },
    daemon: {
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19091,
    },
    daemonPhase: "idle",
    daemonError: null,
    configMode: "external",
    activeModelId: null,
    pull: null,
    lastRefreshedAt: null,
    loading: false,
    errorLine: null,
    removeConfirmId: null,
    dataDir: null,
    totalRamGb: null,
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
