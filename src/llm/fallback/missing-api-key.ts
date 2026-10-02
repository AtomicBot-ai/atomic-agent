import { providerKeyMissing } from "../provider/provider-key.js";
import type {
  LlmProviderConfigEntry,
  ResolvedLlmConfig,
} from "../provider/registry/provider-types.js";

/**
 * Is this a link that cannot authenticate: one that talks to a service
 * which always wants a key, with no key resolved for it?
 *
 * Such a link is skipped by the fallback chain rather than tried. Trying
 * it costs a request whose answer is known (`401 You didn't provide an
 * API key`), and the answer then reads as one more provider failing when
 * nothing failed: the link was never set up.
 *
 * The rule is `providerKeyStatus` in `src/llm/provider/provider-key.ts`,
 * the same one `/model` and the TUI's first-run check read; a link is
 * skipped only when it says `missing`. The key is read from the entry
 * alone (`keyFrom: "entry"`): the config entry carries the key the
 * runtime resolved at load time (`mapUserLlmToRuntime`), the very value
 * the provider factory sends, so "no key here" means no key goes out.
 */
export function lacksRequiredApiKey(entry: LlmProviderConfigEntry): boolean {
  return providerKeyMissing(entry, { keyFrom: "entry" });
}

/** `lacksRequiredApiKey` by chain id, over the providers of `llm`. */
export function lacksRequiredApiKeyIn(
  llm: Pick<ResolvedLlmConfig, "providers">,
): (id: string) => boolean {
  const entries = new Map(llm.providers.map((p) => [p.id, p]));
  return (id) => {
    const entry = entries.get(id);
    return entry !== undefined && lacksRequiredApiKey(entry);
  };
}
