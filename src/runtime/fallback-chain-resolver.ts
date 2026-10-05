import {
  lacksRequiredApiKeyIn,
  resolveFallbackChain,
  withoutKeylessLinks,
  withoutUnavailableLinks,
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
  /**
   * Whether a link cannot serve on this machine right now — the managed
   * local link with no model downloaded (`isLocalLinkWithoutModel`).
   * Absent, no link is judged unavailable.
   */
  linkUnavailable?: (llm: ResolvedLlmConfig, id: string) => boolean;
  logger: Pick<StructuredLogger, "warn">;
}

/**
 * The `resolve` the runtime's `ProviderFallbackChain` runs on every pick
 * and every advance: the configured chain (`resolveFallbackChain`), minus
 * the links that cannot serve a turn at all. That is a link the registry
 * did not build, a link with no API key for a service that wants one
 * (`lacksRequiredApiKey`), and a link the host says cannot serve here
 * (`linkUnavailable`); the primary is never dropped.
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
  let unavailableLinks = new Set<string>();
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
    const keylessNow = new Set<string>();
    resolved = withoutKeylessLinks(
      resolved,
      lacksRequiredApiKeyIn(llm),
      (id) => {
        keylessNow.add(id);
        if (keylessLinks.has(id)) return;
        deps.logger.warn("llm: fallback link skipped (no key)", { id });
      },
    );
    keylessLinks = keylessNow;
    const linkUnavailable = deps.linkUnavailable;
    if (linkUnavailable) {
      // Logged like a keyless link: once, and again if it comes back
      // (the model was pulled) and goes away again (it was removed).
      const unavailableNow = new Set<string>();
      resolved = withoutUnavailableLinks(
        resolved,
        (id) => linkUnavailable(llm, id),
        (id) => {
          unavailableNow.add(id);
          if (unavailableLinks.has(id)) return;
          deps.logger.warn(
            "llm: fallback link skipped (local model not downloaded)",
            { id },
          );
        },
      );
      unavailableLinks = unavailableNow;
    }
    return resolved;
  };
}
