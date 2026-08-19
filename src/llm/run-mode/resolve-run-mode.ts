import type {
  RunModeName,
  RunModeSubRunners,
} from "../../config/llm-run-mode-config.js";
import { DEFAULT_FUSION_CLOUD_SHARE } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";

/** Provider kind that identifies the local leg. */
const LOCAL_PROVIDER_KIND = "llama-server";

export type RunModeDegradationReason =
  | "no-cloud-provider"
  | "no-local-provider"
  | "tool-transport-pinned";

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
  localProviderId: string | null;
  cloudProviderId: string | null;
  /**
   * The provider that must be `llm.activeTextProvider` for `effective`
   * to hold. Never empty — falls back to the configured active provider
   * when neither leg resolves.
   */
  primaryProviderId: string;
  fusion: { cloudShare: number; subRunners: RunModeSubRunners };
  degraded: RunModeDegradation | null;
};

/**
 * Project the `llm.runMode` block onto the providers that actually
 * exist.
 *
 * `llm.activeTextProvider` stays AUTHORITATIVE — `runMode.mode` is
 * purely additive. The effective mode is derived from which provider is
 * active, and a stored `fusion` is only honoured when the cloud leg is
 * the active one:
 *
 * ```
 * derived   = kindOf(activeTextProvider) === "llama-server" ? "local" : "cloud"
 * effective = stored === "fusion" && bothLegsExist && active === cloudId
 *             ? "fusion" : derived
 * ```
 *
 * That rule is what keeps the two keys from ever contradicting each
 * other: an operator who switches provider by hand in Manage → LLM
 * simply drops out of fusion on the next read, with no reconciliation
 * step and no state that lies about what is running. It also means
 * fusion pins the CLOUD provider as the fallback chain's primary, so
 * `resolveFallbackChain` hoists it to the head and appends local at the
 * tail with no changes of its own.
 */
export function resolveRunMode(
  resolved: ResolvedLlmConfig,
): ResolvedRunMode {
  const runMode = resolved.runMode;
  const stored = runMode?.mode ?? null;

  const localProviderId =
    runMode?.localProvider ??
    resolved.providers.find((p) => p.kind === LOCAL_PROVIDER_KIND)?.id ??
    null;
  const cloudProviderId =
    runMode?.cloudProvider ??
    resolved.providers.find((p) => p.kind !== LOCAL_PROVIDER_KIND)?.id ??
    null;

  const activeKind = resolved.providers.find(
    (p) => p.id === resolved.activeTextProvider,
  )?.kind;
  // An unresolvable active provider means a broken config; assume local
  // so a broken file can never silently start spending cloud tokens.
  const derived: RunModeName =
    activeKind === undefined || activeKind === LOCAL_PROVIDER_KIND
      ? "local"
      : "cloud";

  const fusion = {
    cloudShare: runMode?.fusion?.cloudShare ?? DEFAULT_FUSION_CLOUD_SHARE,
    subRunners: runMode?.fusion?.subRunners ?? ("local" as RunModeSubRunners),
  };

  let effective: RunModeName = derived;
  let degraded: RunModeDegradation | null = null;

  if (stored === "fusion") {
    if (cloudProviderId === null) {
      degraded = { reason: "no-cloud-provider", requested: stored };
    } else if (localProviderId === null) {
      degraded = { reason: "no-local-provider", requested: stored };
    } else if (resolved.activeTextProvider === cloudProviderId) {
      // Both legs exist AND the cloud leg is the active provider, which
      // is what makes the cloud provider the fallback chain's primary.
      effective = "fusion";
      if (resolved.toolTransport !== "auto") {
        // Not a downgrade: fusion still runs, but a pinned transport
        // sends one leg the wrong wire shape (grammar to a native-tools
        // provider or vice versa), so the operator has to know.
        degraded = { reason: "tool-transport-pinned", requested: stored };
      }
    }
    // else: the operator switched the active provider by hand, so we
    // simply report `derived`. That is the non-contradiction rule
    // working, not a degradation — nothing to warn about.
  } else if (stored === "cloud" && cloudProviderId === null) {
    degraded = { reason: "no-cloud-provider", requested: stored };
  }

  const primaryProviderId =
    (effective === "local" ? localProviderId : cloudProviderId) ??
    resolved.activeTextProvider;

  return {
    stored,
    effective,
    localProviderId,
    cloudProviderId,
    primaryProviderId,
    fusion,
    degraded,
  };
}
