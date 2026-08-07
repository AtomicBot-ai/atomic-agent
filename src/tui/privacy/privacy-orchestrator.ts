import { getConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { persistAnalyticsEnabled } from "../persist-analytics-enabled.js";
import { persistApprovalRequired } from "../persist-approval-required.js";

/**
 * Only TUI module that persists `analytics.enabled` /
 * `agent.approvalRequired` and hot-applies them to the runtime. The
 * reducer/component stay pure; every side effect (config write,
 * `resetConfigCache`, `runtime.setAnalyticsEnabled`,
 * `runtime.setApprovalRequired`) is funnelled through here — mirrors the
 * other TUI orchestrators.
 */
export class PrivacyOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {}

  /**
   * Push the current settings snapshot into the UI: the persisted
   * `analytics.enabled` plus the LIVE approval-gate state (so a
   * `--no-approval` boot is shown honestly). Also mirrors the approval
   * flag into `state.session` so the diagnostics line stays truthful.
   */
  refresh(): void {
    const approvalRequired = this.runtime.isApprovalRequired();
    this.bus.emit({
      type: "privacy_synced",
      analyticsEnabled: getConfig().analytics.enabled,
      approveEverything: !approvalRequired,
    });
    this.bus.emit({ type: "approval_required_changed", approvalRequired });
  }

  /** Flip analytics to the opposite of the live config value. */
  async toggleAnalytics(): Promise<void> {
    await this.setAnalyticsEnabled(!getConfig().analytics.enabled);
  }

  /** Flip approve-everything to the opposite of the live gate state. */
  async toggleApproveEverything(): Promise<void> {
    await this.setApproveEverything(this.runtime.isApprovalRequired());
  }

  /**
   * Persist `agent.approvalRequired = !on`, then hot-apply it to the
   * live approval gate. `on = true` means the agent runs every
   * approval-gated action without asking, now and on future runs, until
   * toggled back. Fire-safe: a failure surfaces as a sticky error line.
   * When the persist step succeeded and only the hot-apply threw, the
   * error says so explicitly: config.json is already rewritten, so the
   * next boot will come up with the new value even though this process
   * kept the old gate state.
   */
  async setApproveEverything(on: boolean): Promise<void> {
    this.bus.emit({ type: "privacy_action_started" });
    let persisted = false;
    try {
      persistApprovalRequired(!on);
      persisted = true;
      this.runtime.setApprovalRequired(!on);
      this.bus.emit({
        type: "privacy_action_settled",
        message: on
          ? "approve everything ON: the agent now runs every action without asking"
          : "approve everything OFF: risky actions ask for approval again",
      });
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = persisted
        ? `approve everything toggle failed live, but config.json was already rewritten (next start uses the new value): ${msg}`
        : `approve everything toggle failed: ${msg}`;
      this.bus.emit({ type: "privacy_action_settled", error: line });
      this.bus.emit({ type: "runtime_info", line: `privacy: ${line}` });
    }
  }

  /**
   * Persist `analytics.enabled = enabled`, invalidate the config cache,
   * then hot-swap the runtime clients. Fire-safe: a failure surfaces as a
   * sticky error line and the settled action clears `busy`.
   */
  async setAnalyticsEnabled(enabled: boolean): Promise<void> {
    this.bus.emit({ type: "privacy_action_started" });
    try {
      persistAnalyticsEnabled(enabled);
      await this.runtime.setAnalyticsEnabled(enabled);
      this.bus.emit({
        type: "privacy_action_settled",
        message: enabled ? "analytics enabled" : "analytics disabled",
      });
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "privacy_action_settled",
        error: `analytics toggle failed: ${msg}`,
      });
      this.bus.emit({
        type: "runtime_info",
        line: `privacy: analytics toggle failed: ${msg}`,
      });
    }
  }
}
