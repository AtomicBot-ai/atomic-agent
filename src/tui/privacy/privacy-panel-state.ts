import type { ApprovalLevel } from "../../approval/approval-level.js";

/**
 * UI state for the TUI "Privacy" tab: the anonymous-analytics opt-out
 * (shared by product analytics and crash reporting) and the approval
 * ladder position. It is the canonical home for future data-egress
 * preferences so it is modelled as a proper panel slice rather than a
 * one-off toggle.
 *
 * The orchestrator pushes the persisted `analytics.enabled` mirror and
 * the LIVE gate level in through `privacy_synced`; the reducer only
 * folds actions and never touches config / runtime directly.
 */
export interface PrivacyPanelState {
  /** Persisted `analytics.enabled` mirror. */
  analyticsEnabled: boolean;
  /**
   * Live approval-gate ladder position (1 = every gated action asks …
   * 5 = approve everything). Synced from the runtime, not the config
   * file, so a `--no-approval` boot shows the truth.
   */
  approvalLevel: ApprovalLevel;
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
    approvalLevel: 1,
    busy: false,
    message: null,
    lastError: null,
  };
}
