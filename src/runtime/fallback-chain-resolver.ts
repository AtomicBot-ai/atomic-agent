import {
  resolveFallbackChain,
  withoutUnbuiltLinks,
  type ResolvedFallbackChain,
} from "../llm/fallback/index.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

export interface FallbackChainResolverDeps {
  /** The live LLM config, read again on every resolve so hot-swaps land. */
  readLlmConfig: () => ResolvedLlmConfig;
  /**
   * Ids the provider registry built, or `null` while it does not exist
   * yet. Until then the chain is the config's as is; nothing picks a
   * provider that early.
   */
  builtProviderIds: () => readonly string[] | null;
  logger: Pick<StructuredLogger, "warn">;
}

/**
 * The `resolve` the runtime's `ProviderFallbackChain` runs on every pick
 * and every advance: the configured chain (`resolveFallbackChain`), minus
 * the links that cannot serve a turn at all.
 *
 * Separate from bootstrap so the whole path from a config to the links a
 * turn walks can be driven by a test with fake providers. A link it drops
 * is logged once, not once per resolve: this runs on every turn.
 */
export function createFallbackChainResolver(
  deps: FallbackChainResolverDeps,
): () => ResolvedFallbackChain {
  const droppedFallbackLinks = new Set<string>();
  return () => {
    const resolved = resolveFallbackChain(deps.readLlmConfig());
    const listIds = deps.builtProviderIds();
    if (!listIds) return resolved;
    const built = new Set(listIds);
    return withoutUnbuiltLinks(
      resolved,
      (id) => built.has(id),
      (id) => {
        if (droppedFallbackLinks.has(id)) return;
        droppedFallbackLinks.add(id);
        deps.logger.warn("llm: fallback link skipped (provider not built)", {
          id,
        });
      },
    );
  };
}
