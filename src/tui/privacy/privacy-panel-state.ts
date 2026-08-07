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
  /**
   * Live approval-gate mirror, inverted: `true` means the agent runs
   * every approval-gated action without asking (`agent.approvalRequired`
   * is off). Synced from the runtime, not the config file, so a
   * `--no-approval` boot shows the truth.
   */
  approveEverything: boolean;
  /** True while a settings mutation is in flight. */
  busy: boolean;
  /** Sticky one-line success message (e.g. "analytics enabled"). */
  message: string | null;
  /** Sticky one-line error from the most recent failed mutation. */
  lastError: string | null;
}

export function createInitialPrivacyPanelState(): PrivacyPanelState {
  return {
    analyticsEnabled: true,
    approveEverything: false,
    busy: false,
    message: null,
    lastError: null,
  };
}
