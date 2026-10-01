import {
  lacksRequiredApiKey,
  resolveFallbackChain,
  withoutKeylessLinks,
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
 * the links that cannot serve a turn at all. That is a link the registry
 * did not build, and a link with no API key for a service that wants one
 * (`lacksRequiredApiKey`); the primary is never dropped.
 *
 * Separate from bootstrap so the whole path from a config to the links a
 * turn walks can be driven by a test with fake providers. A dropped link
 * is logged once, not once per resolve: this runs on every turn. A keyless
 * link is logged again if it loses its key again after getting one, since
 * the config is read live and a key saved mid-session brings it back.
 */
export function createFallbackChainResolver(
  deps: FallbackChainResolverDeps,
): () => ResolvedFallbackChain {
  const droppedFallbackLinks = new Set<string>();
  let keylessLinks = new Set<string>();
  return () => {
    const llm = deps.readLlmConfig();
    let resolved = resolveFallbackChain(llm);
    const listIds = deps.builtProviderIds();
    if (listIds) {
      const built = new Set(listIds);
      resolved = withoutUnbuiltLinks(
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
    }
    const entries = new Map(llm.providers.map((p) => [p.id, p]));
    const keylessNow = new Set<string>();
    resolved = withoutKeylessLinks(
      resolved,
      (id) => {
        const entry = entries.get(id);
        return entry !== undefined && lacksRequiredApiKey(entry);
      },
      (id) => {
        keylessNow.add(id);
        if (keylessLinks.has(id)) return;
        deps.logger.warn("llm: fallback link skipped (no key)", { id });
      },
    );
    keylessLinks = keylessNow;
    return resolved;
  };
}
