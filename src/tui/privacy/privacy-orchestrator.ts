import { getConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { persistAnalyticsEnabled } from "../persist-analytics-enabled.js";

/**
 * Only TUI module that persists `analytics.enabled` and hot-applies it to
 * the runtime. The reducer/component stay pure; every side effect (config
 * write, `resetConfigCache`, `runtime.setAnalyticsEnabled`) is funnelled
 * through here — mirrors the other TUI orchestrators.
 */
export class PrivacyOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {}

  /** Push the current persisted `analytics.enabled` snapshot into the UI. */
  refresh(): void {
    this.bus.emit({
      type: "privacy_synced",
      analyticsEnabled: getConfig().analytics.enabled,
    });
  }

  /** Flip analytics to the opposite of the live config value. */
  async toggleAnalytics(): Promise<void> {
    await this.setAnalyticsEnabled(!getConfig().analytics.enabled);
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
