import type { RunModeName } from "../../config/llm-run-mode-config.js";
import {
  DEFAULT_FUSION_WORKER_MAX_STEPS,
  DEFAULT_FUSION_WORKER_TIMEOUT_MS,
  DEFAULT_FUSION_WORKERS,
  LOCAL_PROVIDER_KIND,
} from "../../config/llm-run-mode-config.js";
import type {
  LlmProviderConfigEntry,
  ResolvedLlmConfig,
} from "../provider/registry/provider-types.js";

export type RunModeDegradationReason =
  "no-cloud-provider" | "no-second-provider";

export type RunModeDegradation = {
  reason: RunModeDegradationReason;
  /** The mode the operator asked for, before degradation. */
  requested: RunModeName;
};

export type ResolvedRunMode = {
  /** What the config file says, or `null` when the block is absent. */
  stored: RunModeName | null;
  /** What the runtime will actually do. */
  effective: RunModeName;
  /** The cloud leg (fusion's orchestrator), or `null` when none is configured. */
  orchestratorProviderId: string | null;
  /** Display/pricing label for the orchestrator model; the provider's default chat model unless pinned. */
  orchestratorModel: string | null;
  /** The local leg (fusion's workers), or `null` when none is configured. */
  workerProviderId: string | null;
  /** Display label for the worker model; the managed daemon's model unless pinned. */
  workerModel: string | null;
  /**
   * Default fan-out width for a `fusion.delegate` call that names no
   * `maxWorkers`. Not a ceiling — see `UserLlmFusionConfig.workers`.
   */
  workers: number;
  workerMaxSteps: number;
  workerTimeoutMs: number;
  /**
   * The provider that must be `llm.activeTextProvider` for `effective`
   * to hold. Never empty — falls back to the configured active provider
   * when neither leg resolves.
   */
  primaryProviderId: string;
  degraded: RunModeDegradation | null;
};

export type ResolveRunModeOptions = {
  /** `localModels.managed.modelId`, the model the worker daemon serves. */
  managedModelId?: string | null;
};

function isLocalKind(entry: LlmProviderConfigEntry | undefined): boolean {
  return entry?.kind === LOCAL_PROVIDER_KIND;
}

/**
 * Project the `llm.runMode` block onto the providers that actually exist.
 *
 * `llm.activeTextProvider` stays AUTHORITATIVE — `runMode.mode` is purely
 * additive. The effective mode is derived from which provider is active,
 * and a stored `fusion` is only honoured while the orchestrator (cloud)
 * leg is the active one and a worker (llama-server) leg exists:
 *
 * ```
 * derived   = kindOf(activeTextProvider) === "llama-server" ? "local" : "cloud"
 * effective = stored === "fusion" && bothLegs && active === orchestratorId
 *             ? "fusion" : derived
 * ```
 *
 * That rule keeps the two keys from ever contradicting each other: an
 * operator who switches provider by hand in Manage → LLM simply drops
 * out of fusion on the next read, with no reconciliation step and no
 * state that lies about what is running. Fusion therefore pins the
 * cloud provider as the fallback chain's primary and `resolveFallbackChain`
 * needs no changes of its own.
 *
 * A `subscription-cli` provider counts as cloud: it is not a
 * llama-server and cannot host workers.
 */
export function resolveRunMode(
  resolved: ResolvedLlmConfig,
  opts: ResolveRunModeOptions = {},
): ResolvedRunMode {
  const runMode = resolved.runMode;
  const fusion = runMode?.fusion;
  const stored = runMode?.mode ?? null;
  const byId = (id: string | undefined): LlmProviderConfigEntry | undefined =>
    id === undefined ? undefined : resolved.providers.find((p) => p.id === id);

  const active = byId(resolved.activeTextProvider);
  // An unresolvable active provider means a broken config; assume local
  // so a broken file can never silently start spending cloud tokens.
  const derived: RunModeName =
    active === undefined || isLocalKind(active) ? "local" : "cloud";

  const orchestrator =
    byId(fusion?.orchestratorProvider) ??
    (active !== undefined && !isLocalKind(active) ? active : undefined) ??
    resolved.providers.find((p) => !isLocalKind(p));
  // Local first, because that is what fusion is usually for — cloud
  // thinking, local bulk. But only as the DEFAULT: a pinned leg is
  // honoured whatever its kind, so an operator can run the orchestrator
  // locally and the workers in the cloud, or any other pairing their
  // use case calls for. The one thing a leg may not be is the other
  // leg: a fan-out to the model that is already doing the orchestrating
  // buys nothing and doubles the bill.
  const worker =
    byId(fusion?.workerProvider) ??
    resolved.providers.find(
      (p) => isLocalKind(p) && p.id !== orchestrator?.id,
    ) ??
    resolved.providers.find((p) => p.id !== orchestrator?.id);

  const orchestratorProviderId = orchestrator?.id ?? null;
  const workerProviderId = worker?.id ?? null;

  let effective: RunModeName = derived;
  let degraded: RunModeDegradation | null = null;
  if (stored === "fusion") {
    if (orchestratorProviderId === null) {
      degraded = { reason: "no-cloud-provider", requested: stored };
    } else if (workerProviderId === null) {
      // Two legs, two providers. Which kinds they are is the operator's
      // business; that there are two of them is not negotiable.
      degraded = { reason: "no-second-provider", requested: stored };
    } else if (resolved.activeTextProvider === orchestratorProviderId) {
      effective = "fusion";
    }
    // else: the operator switched the active provider by hand — report
    // `derived`. That is the non-contradiction rule working, not a
    // degradation, so nothing to warn about.
  } else if (stored === "cloud" && orchestratorProviderId === null) {
    degraded = { reason: "no-cloud-provider", requested: stored };
  }

  const primaryProviderId =
    (effective === "local" ? workerProviderId : orchestratorProviderId) ??
    resolved.activeTextProvider;

  return {
    stored,
    effective,
    orchestratorProviderId,
    orchestratorModel:
      fusion?.orchestratorModel ??
      orchestrator?.defaultChatModel ??
      orchestrator?.model ??
      null,
    workerProviderId,
    workerModel:
      fusion?.workerModel ?? opts.managedModelId ?? worker?.model ?? null,
    workers: fusion?.workers ?? DEFAULT_FUSION_WORKERS,
    workerMaxSteps: fusion?.workerMaxSteps ?? DEFAULT_FUSION_WORKER_MAX_STEPS,
    workerTimeoutMs:
      fusion?.workerTimeoutMs ?? DEFAULT_FUSION_WORKER_TIMEOUT_MS,
    primaryProviderId,
    degraded,
  };
}
