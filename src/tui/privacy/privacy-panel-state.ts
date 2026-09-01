import type { SessionGrantsSnapshot } from "../../approval/approval-gate.js";

/**
 * UI state for the TUI "Privacy" tab: the anonymous-analytics opt-out
 * (shared by product analytics and crash reporting). It is the
 * canonical home for future data-egress preferences so it is modelled
 * as a proper panel slice rather than a one-off toggle.
 *
 * The orchestrator pushes the persisted `analytics.enabled` mirror in
 * through `privacy_synced`; the reducer only folds actions and never
 * touches config / runtime directly.
 */
export interface PrivacyPanelState {
  /** Persisted `analytics.enabled` mirror. */
  analyticsEnabled: boolean;
  /** True while a settings mutation is in flight. */
  busy: boolean;
  /** Sticky one-line success message (e.g. "analytics enabled"). */
  message: string | null;
  /** Sticky one-line error from the most recent failed mutation. */
  lastError: string | null;
  /**
   * Live session-scoped point grants (categories + shell command shapes)
   * mirrored from the approval gate. Read-only here — cleared when the
   * session is switched / restarted, never persisted.
   */
  sessionGrants: SessionGrantsSnapshot;
}

export function createInitialPrivacyPanelState(): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    busy: false,
    message: null,
    lastError: null,
    sessionGrants: { categories: [], shapes: [] },
  };
}
