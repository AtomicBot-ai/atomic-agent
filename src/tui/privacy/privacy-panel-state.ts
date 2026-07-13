/**
 * UI state for the TUI "Privacy" tab. Currently the tab hosts a single
 * control — the anonymous-analytics opt-out (shared by product analytics
 * and crash reporting) — but it is the canonical home for future
 * data-egress preferences so it is modelled as a proper panel slice
 * rather than a one-off toggle.
 *
 * The orchestrator pushes the persisted `analytics.enabled` mirror in
 * through `privacy_synced`; the reducer only folds actions and never
 * touches config / runtime directly.
 */
export interface PrivacyPanelState {
  /** Persisted `analytics.enabled` mirror. */
  analyticsEnabled: boolean;
  /** True while a `setAnalyticsEnabled` mutation is in flight. */
  busy: boolean;
  /** Sticky one-line success message (e.g. "analytics enabled"). */
  message: string | null;
  /** Sticky one-line error from the most recent failed mutation. */
  lastError: string | null;
}

export function createInitialPrivacyPanelState(): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    busy: false,
    message: null,
    lastError: null,
  };
}
