import {
  clampApprovalLevel,
  formatApprovalLevel,
  type ApprovalLevel,
} from "../../approval/approval-level.js";
import { getConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { persistAnalyticsEnabled } from "../persist-analytics-enabled.js";
import { persistApprovalLevel } from "../persist-approval-level.js";

/**
 * Only TUI module that persists `analytics.enabled` /
 * `agent.approvalLevel` and hot-applies them to the runtime. The
 * reducer/component stay pure; every side effect (config write,
 * `resetConfigCache`, `runtime.setAnalyticsEnabled`,
 * `runtime.setApprovalLevel`) is funnelled through here — mirrors the
 * other TUI orchestrators.
 */
export class PrivacyOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {}

  /**
   * Push the current settings snapshot into the UI: the persisted
   * `analytics.enabled` plus the LIVE approval-gate level (so a
   * `--no-approval` boot is shown honestly). Also mirrors the level
   * into `state.session` so the diagnostics line stays truthful.
   */
  refresh(): void {
    const approvalLevel = this.runtime.getApprovalLevel();
    this.bus.emit({
      type: "privacy_synced",
      analyticsEnabled: getConfig().analytics.enabled,
      approvalLevel,
    });
    this.bus.emit({ type: "approval_level_changed", approvalLevel });
  }

  /** Flip analytics to the opposite of the live config value. */
  async toggleAnalytics(): Promise<void> {
    await this.setAnalyticsEnabled(!getConfig().analytics.enabled);
  }

  /**
   * Persist `agent.approvalLevel`, then hot-apply it to the live
   * approval gate. Out-of-range input is clamped to [1, 5]. Fire-safe:
   * a failure surfaces as a sticky error line. When the persist step
   * succeeded and only the hot-apply threw, the error says so
   * explicitly: config.json is already rewritten, so the next boot
   * will come up with the new value even though this process kept the
   * old gate state.
   */
  async setApprovalLevel(level: number): Promise<void> {
    const target = clampApprovalLevel(level);
    this.bus.emit({ type: "privacy_action_started" });
    let persisted = false;
    try {
      persistApprovalLevel(target);
      persisted = true;
      this.runtime.setApprovalLevel(target);
      this.bus.emit({
        type: "privacy_action_settled",
        message: describeLevelChange(target),
      });
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = persisted
        ? `approval level change failed live, but config.json was already rewritten (next start uses the new value): ${msg}`
        : `approval level change failed: ${msg}`;
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

/**
 * One honest sentence per level for the sticky success message. Level 5
 * repeats the old approve-everything warning verbatim in spirit: the
 * agent now runs every action without asking.
 */
function describeLevelChange(level: ApprovalLevel): string {
  const label = `approval level ${formatApprovalLevel(level)}`;
  const detail: Record<ApprovalLevel, string> = {
    1: "every approval-gated action asks first",
    2: "file writes inside the project run without asking; everything else still asks",
    3: "file changes in your home directory and HTTP requests also run without asking",
    4: "guarded shell commands, scripts, and process kills also run without asking",
    5: "the agent now runs every action without asking",
  };
  return `${label}: ${detail[level]}`;
}
