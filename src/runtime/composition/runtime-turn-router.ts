import { LOCAL_PROVIDER_KIND, type AtomicAgentConfig } from "../../config/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import { localFirstTurnHead } from "../../llm/fallback/index.js";
import { extractRouteFeatures, routeTurn, type RouteDecision } from "../../llm/router/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { isLocalLinkWithoutModel } from "../local-link-availability.js";
import { estimateTokens } from "../../prompt/token-budget.js";

export interface RouteTurnProviderParams {
  config: AtomicAgentConfig;
  userMessage: string;
  workingDir: string;
  pinnedProviderId: string | undefined;
  runMode: Pick<ResolvedRunMode, "stored" | "effective">;
  isRegistered: (providerId: string) => boolean;
  logger: Pick<StructuredLogger, "info">;
  sessionId: string;
  /**
   * Whether a link cannot serve here now. Default: the managed local
   * link with no model on disk (`isLocalLinkWithoutModel`).
   */
  linkUnavailable?: (llm: ResolvedLlmConfig, providerId: string) => boolean;
  /**
   * Tokens this session's next prompt needs, as far as the caller knows
   * (ATO-2537). Absent or null: unknown, local-first does not check size.
   */
  sessionPromptTokens?: number | null;
  /** The window a local link builds its prompt against. Absent: unknown. */
  localContextWindow?: (providerId: string) => number | null;
}

/**
 * The provider this turn starts on, or undefined to leave the turn as it
 * was. Read once, before the turn starts, from the live config. The
 * caller puts the answer first in the turn's fallback chain
 * (`setTurnPrimary`): every step starts on it, and a failure falls over
 * to the next `llm.fallback` link.
 *
 * Two sources, in this order: a matching `llm.router` rule (ATO-483,
 * `src/llm/router/README.md`), else the local-first cascade
 * (`llm.fallback.localFirst`, ATO-2208, `local-first-head.ts`).
 *
 * `needsTools` is true: every agent turn offers tools (even its reply is
 * one), so a rule's `needsTools: false` only matches a caller that hides
 * them all, which none does today.
 */
export function routeTurnProvider(params: RouteTurnProviderParams): string | undefined {
  return routeByRules(params) ?? localFirstProvider(params);
}

function routeByRules(params: RouteTurnProviderParams): string | undefined {
  const router = params.config.llm?.router;
  if (!router?.enabled) return undefined;
  const resolved = resolveLlmConfig(params.config);
  const decision: RouteDecision = routeTurn({
    router,
    request: {
      message: params.userMessage,
      workingDir: params.workingDir,
      needsTools: true,
    },
    runMode: { stored: params.runMode.stored, effective: params.runMode.effective },
    activeProviderId: resolved.activeTextProvider,
    ...(params.pinnedProviderId !== undefined
      ? { pinnedProviderId: params.pinnedProviderId }
      : {}),
    providers: routerProviders(resolved, params.isRegistered),
  });
  if (!decision.routed) return undefined;
  // The rule's name and the provider only: never the message.
  params.logger.info("model router picked a provider for the turn", {
    sessionId: params.sessionId,
    providerId: decision.providerId,
    rule: decision.rule,
  });
  return decision.providerId;
}

function localFirstProvider(params: RouteTurnProviderParams): string | undefined {
  if (params.config.llm?.fallback?.localFirst !== true) return undefined;
  const resolved = resolveLlmConfig(params.config);
  const unavailable =
    params.linkUnavailable ??
    ((llm: ResolvedLlmConfig, id: string) => isLocalLinkWithoutModel(llm, id, params.config));
  const decision = localFirstTurnHead({
    localFirst: true,
    effectiveRunMode: params.runMode.effective,
    activeProviderId: resolved.activeTextProvider,
    ...(params.pinnedProviderId !== undefined
      ? { pinnedProviderId: params.pinnedProviderId }
      : {}),
    providers: routerProviders(resolved, () => true),
    hasImage: extractRouteFeatures(params.userMessage).hasImage,
    isRegistered: params.isRegistered,
    isUnavailable: (id) => unavailable(resolved, id),
    ...(params.sessionPromptTokens !== undefined
      ? { sessionPromptTokens: params.sessionPromptTokens }
      : {}),
    ...(params.localContextWindow !== undefined
      ? { localContextWindow: params.localContextWindow }
      : {}),
    ...(params.config.agent?.compaction?.triggerRatio !== undefined
      ? { fitRatio: params.config.agent.compaction.triggerRatio }
      : {}),
  });
  if (decision.head === null) {
    if (decision.reason === "too-long") {
      // Sizes only: never the message.
      params.logger.info("local-first cascade: session too long for the local window, turn stays in the cloud", {
        sessionId: params.sessionId,
        promptTokens: params.sessionPromptTokens ?? null,
      });
    }
    return undefined;
  }
  // The provider only: never the message.
  params.logger.info("local-first cascade: turn starts on the local model", {
    sessionId: params.sessionId,
    providerId: decision.head,
  });
  return decision.head;
}

/**
 * What the session's next prompt needs, for the local-first size check
 * (ATO-2537): the last prompt this session built (`contextUsage.tokens`,
 * the provider's own count once a step completed) plus the new message.
 * Null when no prompt was built yet: a new session is small, and an
 * unknown size keeps today's behaviour.
 */
export function sessionPromptEstimate(
  lastPromptTokens: number | null | undefined,
  userMessage: string,
): number | null {
  if (lastPromptTokens === null || lastPromptTokens === undefined || !(lastPromptTokens > 0)) {
    return null;
  }
  return lastPromptTokens + estimateTokens(userMessage);
}

function routerProviders(
  resolved: ResolvedLlmConfig,
  isRegistered: (providerId: string) => boolean,
) {
  return resolved.providers
    .filter((p) => isRegistered(p.id))
    .map((p) => ({
      id: p.id,
      ...(p.supportsTools !== undefined ? { supportsTools: p.supportsTools } : {}),
      ...(p.supportsVision !== undefined ? { supportsVision: p.supportsVision } : {}),
      ...(p.kind === LOCAL_PROVIDER_KIND ? { local: true } : {}),
    }));
}
