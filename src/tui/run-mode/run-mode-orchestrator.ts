import { getConfig, type RunModeName } from "../../config/index.js";
import {
  describeRunModeDegradation,
  resolveRunMode,
} from "../../llm/run-mode/index.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { setRunModeInConfig } from "../persist-run-mode.js";

/**
 * Only TUI module that writes `llm.runMode` or moves the active text
 * provider for a mode change. The reducer and components stay pure.
 *
 * A mode switch is deliberately two steps in a fixed order: persist
 * both keys in one write, THEN hot-apply the provider swap. If the swap
 * fails the file is already correct, so the next boot comes up in the
 * requested mode — and the error says so rather than pretending the
 * switch did not happen.
 */
export class RunModeOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {}

  /** Push the resolved run-mode snapshot into the UI. */
  refresh(): void {
    const resolved = resolveRunMode(resolveLlmConfig(getConfig()));
    this.bus.emit({
      type: "run_mode_synced",
      effective: resolved.effective,
      stored: resolved.stored,
      cloudShare: resolved.fusion.cloudShare,
      localLabel: this.modelLabel(resolved.localProviderId),
      cloudLabel: this.modelLabel(resolved.cloudProviderId),
      localProviderId: resolved.localProviderId,
      cloudProviderId: resolved.cloudProviderId,
      cloudProviderMissing: resolved.cloudProviderId === null,
      localProviderMissing: resolved.localProviderId === null,
      degradedMessage: resolved.degraded
        ? describeRunModeDegradation(resolved.degraded)
        : null,
    });
  }

  /**
   * Switch mode (and optionally the dial), persisting both config keys
   * in one write before touching the runtime.
   *
   * A mode the config cannot support is NOT written: `resolveRunMode`
   * is consulted first, and an unsupported request surfaces its
   * degradation sentence instead. Writing a mode that immediately
   * resolves to something else would leave the file disagreeing with
   * the strip on the very next refresh.
   */
  async setMode(mode: RunModeName, cloudShare?: number): Promise<void> {
    this.bus.emit({ type: "run_mode_change_started" });
    try {
      const target = this.resolveTarget(mode, cloudShare);
      if (target.blocked) {
        this.bus.emit({
          type: "run_mode_change_settled",
          error: target.blocked,
        });
        this.refresh();
        return;
      }
      setRunModeInConfig({
        mode,
        primaryProviderId: target.primaryProviderId,
        ...(cloudShare === undefined ? {} : { cloudShare }),
      });
      await this.runtime.providerRegistry.setActive(target.primaryProviderId);
      this.bus.emit({ type: "run_mode_change_settled" });
    } catch (err) {
      this.bus.emit({
        type: "run_mode_change_settled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.refresh();
  }

  /**
   * Which provider must become active for `mode`, or why it cannot.
   *
   * Resolution runs against a hypothetical config in which the mode is
   * already stored, so the answer describes the world AFTER the switch
   * rather than the one before it.
   */
  private resolveTarget(
    mode: RunModeName,
    cloudShare?: number,
  ): { primaryProviderId: string; blocked?: string } {
    const live = resolveLlmConfig(getConfig());
    const hypothetical = resolveRunMode({
      ...live,
      runMode: {
        ...live.runMode,
        mode,
        ...(cloudShare === undefined
          ? {}
          : { fusion: { ...live.runMode?.fusion, cloudShare } }),
      },
      // Pretend the leg this mode needs is already active, so the
      // fusion rule ("cloud leg must be primary") can be satisfied.
      activeTextProvider: this.legFor(mode, live.activeTextProvider),
    });
    if (hypothetical.degraded && hypothetical.effective !== mode) {
      return {
        primaryProviderId: hypothetical.primaryProviderId,
        blocked: describeRunModeDegradation(hypothetical.degraded),
      };
    }
    return { primaryProviderId: hypothetical.primaryProviderId };
  }

  private legFor(mode: RunModeName, fallback: string): string {
    const resolved = resolveRunMode(resolveLlmConfig(getConfig()));
    if (mode === "local") return resolved.localProviderId ?? fallback;
    return resolved.cloudProviderId ?? fallback;
  }

  private modelLabel(providerId: string | null): string | null {
    if (!providerId) return null;
    const entry = resolveLlmConfig(getConfig()).providers.find(
      (p) => p.id === providerId,
    );
    if (!entry) return null;
    return (
      entry.defaultChatModel ??
      entry.model ??
      getConfig().localModels.managed.modelId ??
      entry.id
    );
  }
}
