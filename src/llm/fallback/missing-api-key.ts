import { presetForEntryId } from "../../tui/providers/provider-presets.js";
import type {
  LlmProviderConfigEntry,
  ResolvedLlmConfig,
} from "../provider/registry/provider-types.js";

/**
 * Kinds that only ever talk to the vendor's own cloud API, which answers
 * every request without a key with a 401.
 */
const KEYED_CLOUD_KINDS = new Set(["openrouter", "aimlapi", "gemini"]);

/**
 * A header name that may carry a credential an entry sets by hand
 * (`authorization`, `x-api-key`, `x-goog-api-key`, `x-auth-token`, ...).
 * Broad on purpose: a false match only means a link is tried as before.
 */
const CREDENTIAL_HEADER = /key|auth|token/i;

/**
 * Is this a link that cannot authenticate: one that talks to a service
 * which always wants a key, with no key resolved for it?
 *
 * Such a link is skipped by the fallback chain rather than tried. Trying
 * it costs a request whose answer is known (`401 You didn't provide an
 * API key`), and the answer then reads as one more provider failing when
 * nothing failed: the link was never set up. The config entry carries the
 * key the runtime resolved at load time (`mapUserLlmToRuntime`), the very
 * value the provider factory sends, so "no key here" means no key goes
 * out.
 *
 * Deliberately narrow. A request without a key is a 401 from a cloud
 * service and a normal request to a keyless server (LM Studio, Ollama, a
 * vLLM on the LAN), and nothing in an entry says which one it points at
 * except its kind and the preset it was made from. So the answer is yes
 * only for:
 *  - the cloud kinds above, on the vendor's own endpoint (no `baseUrl`
 *    override, which could be a proxy holding the key itself), and
 *  - an entry made from a cloud preset (`dashscope`, `groq-2`, ...) whose
 *    base URL is still that service's own host.
 * Anything else is tried as before. At worst it answers 401, which is
 * reported as that link's failure.
 */
export function lacksRequiredApiKey(entry: LlmProviderConfigEntry): boolean {
  if (hasCredential(entry)) return false;
  if (KEYED_CLOUD_KINDS.has(entry.kind)) return !entry.baseUrl;
  const preset = presetForEntryId(entry.id);
  if (!preset || preset.local) return false;
  const host = hostOf(entry.baseUrl);
  return host !== null && host === hostOf(preset.baseUrl);
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

function hasCredential(entry: LlmProviderConfigEntry): boolean {
  if (typeof entry.apiKey === "string" && entry.apiKey.trim().length > 0) {
    return true;
  }
  const named = entry.apiKeyHeader?.trim().toLowerCase();
  // Read defensively: this runs on every pick, and a hand-edited config
  // with a non-string header value must not stop every turn.
  return Object.entries(entry.headers ?? {}).some(([name, value]) => {
    const lower = name.trim().toLowerCase();
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      (CREDENTIAL_HEADER.test(lower) || lower === named)
    );
  });
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
