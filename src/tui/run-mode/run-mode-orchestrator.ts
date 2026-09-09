import { getConfig, type RunModeName } from "../../config/index.js";
import { usesExternalCliAuth } from "../../config/provider-auth-mode.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { LOCAL_PROVIDER_KIND } from "../../config/llm-run-mode-config.js";
import { resolveLlmConfig } from "../../llm/provider/registry/index.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import {
  describeRunMode,
  describeRunModeDegradation,
  resolveRunMode,
  type ResolvedRunMode,
} from "../../llm/run-mode/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { LocalModelsOrchestrator } from "../local-models/local-models-orchestrator.js";
import { wrapLlmConfigError } from "../persist-llm-provider.js";
import {
  setRunModeInConfig,
  type RunModeChangeOptions,
} from "../persist-run-mode.js";
import type { ProvidersOrchestrator } from "../providers/providers-orchestrator.js";
import type { TuiAction } from "../tui-action.js";
import { describeFusionIntro } from "./fusion-intro.js";

export interface RunModeOrchestratorDeps {
  /** Fires `providerRegistry.setActive` — the hot-apply half. */
  readonly runtime: Pick<AgentRuntime, "providerRegistry">;
  readonly bus: { emit(action: TuiAction): void };
  readonly providers: Pick<ProvidersOrchestrator, "refresh" | "ensureInlineModels">;
  readonly localModels: Pick<LocalModelsOrchestrator, "startDaemon">;
}

/**
 * The only TUI module that writes `llm.runMode`.
 *
 * `setMode` is: resolve against config → refuse (one sentence) when the
 * mode would immediately degrade → persist the mode AND the provider it
 * needs in one write → hot-apply the provider → re-mirror the panel.
 * Persist first, apply second, so a failed hot-swap still boots into
 * the mode the operator chose.
 *
 * Fusion additionally starts the managed worker daemon when it is down:
 * `autoStartIfReady` keys on `local-llama` being the ACTIVE provider,
 * and under fusion the active provider is the cloud orchestrator, so
 * nothing else would bring the workers up.
 */
export class RunModeOrchestrator {
  constructor(private readonly deps: RunModeOrchestratorDeps) {}

  /** What the mode resolves to right now, from config. */
  current(): ResolvedRunMode {
    const config = getConfig();
    return resolveRunMode(resolveLlmConfig(config), {
      managedModelId: config.localModels.managed.modelId,
    });
  }

  async setMode(mode: RunModeName, opts: RunModeChangeOptions = {}): Promise<void> {
    const config = getConfig();
    const resolved = resolveLlmConfig(config);
    const rm = resolveRunMode(resolved);
    const isCloud = (id: string | null | undefined): boolean =>
      id !== null &&
      id !== undefined &&
      resolved.providers.some((p) => p.id === id && p.kind !== LOCAL_PROVIDER_KIND);
    const activeIsCloud = isCloud(resolved.activeTextProvider);

    let leg: string | null;
    let fusion: RunModeChangeOptions["fusion"] = opts.fusion;
    if (mode === "fusion") {
      leg =
        opts.fusion?.orchestratorProvider ??
        (activeIsCloud ? resolved.activeTextProvider : null) ??
        this.firstUsableCloudProvider(resolved) ??
        rm.orchestratorProviderId;
      if (leg === null || leg === undefined) {
        this.refuse(describeRunModeDegradation({ reason: "no-cloud-provider", requested: mode }));
        return;
      }
      if (rm.workerProviderId === null) {
        this.refuse(describeRunModeDegradation({ reason: "no-local-provider", requested: mode }));
        return;
      }
      // Pin BOTH legs. Leaving either to the resolver's "first entry of
      // that kind" default lets the pair drift with the order of
      // `llm.providers` — and picked the wrong half outright when a
      // cloud-kind entry points at a local server, which is how both
      // slots once came to name a local model.
      fusion = {
        ...fusion,
        orchestratorProvider: leg,
        workerProvider: opts.fusion?.workerProvider ?? rm.workerProviderId,
      };
    } else if (mode === "cloud") {
      leg = activeIsCloud ? resolved.activeTextProvider : rm.orchestratorProviderId;
      if (leg === null) {
        this.refuse(describeRunModeDegradation({ reason: "no-cloud-provider", requested: mode }));
        return;
      }
    } else {
      leg = rm.workerProviderId ?? "local-llama";
    }

    try {
      setRunModeInConfig({
        mode,
        activeTextProvider: leg,
        ...(fusion ? { fusion } : {}),
        ...(opts.managedParallel === undefined ? {} : { managedParallel: opts.managedParallel }),
      });
    } catch (err) {
      this.refuse(wrapLlmConfigError(err));
      return;
    }
    try {
      if (leg !== resolved.activeTextProvider) {
        await this.deps.runtime.providerRegistry.setActive(leg);
      }
    } catch (err) {
      this.deps.bus.emit({
        type: "runtime_info",
        line: `run mode: saved, but switching to "${leg}" failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    this.deps.providers.refresh();
    if (mode !== "local") void this.deps.providers.ensureInlineModels(leg);
    const now = this.current();
    this.deps.bus.emit({ type: "runtime_info", line: `run mode: ${describeRunMode(now)}` });
    // Only on the way IN. Re-applying fusion to change the orchestrator
    // is not a moment that needs the mode explained again.
    if (now.effective === "fusion" && rm.effective !== "fusion") {
      this.deps.bus.emit({ type: "system_message", text: describeFusionIntro(now) });
    }
    if (now.effective === "fusion") {
      const local = getConfig().localModels;
      if (local.mode === "managed" && local.managed.modelId) {
        // Fire-and-forget: the daemon reports its own progress lines.
        void this.deps.localModels.startDaemon();
      }
    }
  }

  /**
   * A cloud provider that could actually answer: credentials first, so
   * switching to fusion does not pin an entry whose key was never added
   * and then fail on the first turn. Falls back to any cloud entry —
   * the pre-flight has already said whether one is usable.
   */
  private firstUsableCloudProvider(resolved: ResolvedLlmConfig): string | null {
    const cloud = resolved.providers.filter((p) => p.kind !== LOCAL_PROVIDER_KIND);
    const keyed = cloud.find((p) => Boolean(resolveLlmProviderApiKey(p)) || usesExternalCliAuth(p));
    return (keyed ?? cloud[0])?.id ?? null;
  }

  private refuse(line: string): void {
    this.deps.bus.emit({ type: "composer_notice", text: line });
    this.deps.bus.emit({ type: "runtime_info", line: `run mode: ${line}` });
  }
}
