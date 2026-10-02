import {
  lacksRequiredApiKeyIn,
  resolveFallbackChain,
} from "../../../llm/fallback/index.js";
import type { ResolvedLlmConfig } from "../../../llm/provider/registry/provider-types.js";
import type { FallbackLinkRow } from "./fallback-panel-state.js";

const LOCAL_KIND = "llama-server";

export interface FallbackChainView {
  links: readonly FallbackLinkRow[];
  addableProviderIds: readonly string[];
  appendLocal: boolean;
}

/**
 * Build the pane's view of the fallback chain from a resolved LLM config.
 * Pure — no config I/O — so it is unit-testable and the orchestrator can
 * feed it the live `resolveLlmConfig(getConfig())`.
 *
 * `links` is the *effective* order from `resolveFallbackChain` (active
 * provider hoisted to head, local last-resort appended when `appendLocal`),
 * annotated per link:
 *  - `isActive` on the head (the active text provider / primary),
 *  - `isAppendedLocal` on a local link that `appendLocal` synthesised
 *    rather than the operator listing it in `chain`,
 *  - `skippedNoKey` on a fallback link the runtime skips for having no
 *    key, by the same rule (`lacksRequiredApiKeyIn`). The pane still
 *    lists it, as the config does, but says it will not be tried.
 *
 * `addableProviderIds` is every configured provider not already a link,
 * in config order — the menu of links the operator can still add.
 */
export function buildFallbackChainView(
  resolved: ResolvedLlmConfig,
): FallbackChainView {
  const appendLocal = resolved.fallback?.appendLocal ?? true;
  const explicitChain = resolved.fallback?.chain ?? [];
  const explicit = new Set(explicitChain);
  const localId = resolved.providers.find((p) => p.kind === LOCAL_KIND)?.id;

  const { chain } = resolveFallbackChain(resolved);
  const lacksKey = lacksRequiredApiKeyIn(resolved);
  const links: FallbackLinkRow[] = chain.map((id, index) => {
    const provider = resolved.providers.find((p) => p.id === id);
    // A local link counts as auto-appended only when appendLocal put it
    // there: it is the local provider, not in the operator's explicit
    // chain, and appendLocal is on. An operator who lists the local
    // provider by hand keeps it reorderable.
    const isAppendedLocal =
      appendLocal &&
      id === localId &&
      !explicit.has(id) &&
      id !== resolved.activeTextProvider;
    return {
      providerId: id,
      modelLabel: provider?.defaultChatModel ?? provider?.model ?? null,
      kind: provider?.kind ?? "unknown",
      isActive: index === 0,
      isAppendedLocal,
      skippedNoKey: index !== 0 && lacksKey(id),
    };
  });

  const inChain = new Set(chain);
  const addableProviderIds = resolved.providers
    .map((p) => p.id)
    .filter((id) => !inChain.has(id));

  return { links, addableProviderIds, appendLocal };
}
