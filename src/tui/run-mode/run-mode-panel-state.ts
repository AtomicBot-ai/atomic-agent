import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * UI state for the Run-section mode strip and its dial overlay.
 *
 * Everything here is a MIRROR pushed in by `run-mode-orchestrator` via
 * `run_mode_synced`; the reducer never reads config or the runtime. The
 * mirror is of the RESOLVED mode, so `effective` already accounts for a
 * missing cloud leg or an operator who switched provider by hand.
 */
export interface RunModePanelState {
  /** Resolved mode actually in force. */
  effective: RunModeName;
  /** Mode stored in config, when it differs from `effective`. */
  stored: RunModeName | null;
  /** Fusion dial, 0-100. */
  cloudShare: number;
  /** Display labels for the two legs, or null when unknown. */
  localLabel: string | null;
  cloudLabel: string | null;
  /**
   * Provider id filling each leg, as `resolveRunMode` resolved it.
   *
   * Separate from the labels, which carry the MODEL name: with two cloud
   * providers configured, "the cloud leg" is a specific one of them
   * (`llm.runMode.cloudProvider`, else the first non-llama-server entry)
   * and an operator cannot tell which without being told its id.
   */
  localProviderId: string | null;
  cloudProviderId: string | null;
  /**
   * Whether each leg is configured at all. Tracked separately from the
   * labels because a provider can exist with no model name resolved
   * yet, and "unavailable" must not be inferred from "unnamed".
   */
  cloudProviderMissing: boolean;
  localProviderMissing: boolean;
  /** One-line explanation when the requested mode was degraded. */
  degradedMessage: string | null;
  /** True while a mode switch is being persisted. */
  busy: boolean;
  lastError: string | null;
  /** Non-null while the dial overlay owns the keyboard. */
  picker: RunModePickerState | null;
}

/**
 * The overlay's own draft. Kept separate from the committed mirror so
 * Esc can revert to what was in force when it opened — the same
 * contract `ThemePicker` offers.
 */
export interface RunModePickerState {
  cursor: number;
  draftMode: RunModeName;
  draftCloudShare: number;
  /** Digits typed so far for a direct dial entry; committed on Enter. */
  digitBuffer: string;
}

export function createInitialRunModePanelState(): RunModePanelState {
  return {
    effective: "local",
    stored: null,
    cloudShare: 40,
    localLabel: null,
    cloudLabel: null,
    localProviderId: null,
    cloudProviderId: null,
    cloudProviderMissing: false,
    localProviderMissing: false,
    degradedMessage: null,
    busy: false,
    lastError: null,
    picker: null,
  };
}
