import { getConfig, type RunModeName } from "../../config/index.js";
import {
  describeRunModeDegradation,
  resolveRunMode,
} from "../../llm/run-mode/index.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { setRunModeInConfig } from "../persist-run-mode.js";
import {
  describeRunModeSetup,
  openRunModeSetup,
  runModeSetupTarget,
  type RunModeSetupTarget,
} from "./run-mode-setup.js";

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
   *
   * When what the mode lacks is a whole leg, the sentence is no longer
   * the entire response: the operator is taken to the screen that can
   * supply it. Picking a mode is a statement of intent, and answering
   * intent with a refusal and no route is what made Cloud unreachable
   * on a fresh install without knowing where Manage → LLM lives.
   */
  async setMode(mode: RunModeName, cloudShare?: number): Promise<void> {
    this.bus.emit({ type: "run_mode_change_started" });
    try {
      const target = this.resolveTarget(mode, cloudShare);
      if (target.blocked) {
        this.bus.emit({
          type: "run_mode_change_settled",
          error: target.blocked.message,
        });
        if (target.blocked.setup) {
          openRunModeSetup(
            (action) => this.bus.emit(action),
            target.blocked.setup,
          );
        }
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
      // The active provider just moved, and everything that names the
      // model — the composer's meta row above all — reads it off the
      // providers mirror, not off this panel's. Nothing else republishes
      // that mirror after a mode switch, so the composer went on naming
      // the previous leg's model until some unrelated event refreshed
      // it. Emitting rather than dispatching is load-bearing: the bus is
      // bridged into the reducer one way, so a dispatched request would
      // reach the reducer (which ignores it) and never the providers
      // orchestrator that actually rebuilds the rows.
      this.bus.emit({ type: "providers_refresh_requested" });
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
   *
   * A missing leg is checked first and separately from the degradation
   * the resolver reports, because the two do not line up. `resolveRunMode`
   * degrades `cloud` and `fusion` when the cloud provider is absent, but
   * a `local` request with no llama-server provider is not a degradation
   * at all — it resolves quietly to whatever is active, which used to let
   * this method write `runMode.mode: "local"` while leaving a cloud
   * provider active. That is precisely the file-disagrees-with-the-strip
   * state the comment above promises never to write, and it happened in
   * silence: no swap, no sentence, nothing.
   */
  private resolveTarget(
    mode: RunModeName,
    cloudShare?: number,
  ): {
    primaryProviderId: string;
    blocked?: { message: string; setup?: RunModeSetupTarget };
  } {
    const live = resolveLlmConfig(getConfig());
    const current = resolveRunMode(live);
    const setup = runModeSetupTarget(mode, {
      cloudProviderMissing: current.cloudProviderId === null,
      localProviderMissing: current.localProviderId === null,
    });
    if (setup) {
      return {
        primaryProviderId: current.primaryProviderId,
        blocked: { message: describeRunModeSetup(setup), setup },
      };
    }
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
    // Both legs exist and the mode still will not hold. Nothing shipped
    // reaches here today — every degradation that flips `effective` is a
    // missing leg, caught above — so this stays a report with no route,
    // which is the right shape for a cause we cannot name a screen for.
    if (hypothetical.degraded && hypothetical.effective !== mode) {
      return {
        primaryProviderId: hypothetical.primaryProviderId,
        blocked: { message: describeRunModeDegradation(hypothetical.degraded) },
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
