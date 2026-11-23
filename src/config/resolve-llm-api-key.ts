import { isOtherComputerOnNetworkUrl } from "../llm/provider/openai/network-server-address.js";
import { isLocalProviderUrl } from "../llm/provider/presets/is-local-provider-url.js";
import type { UserLlmProviderEntry } from "./llm-config.js";

/**
 * Resolve API keys for provider registry entries. File-stored `apiKey`
 * wins; otherwise well-known env vars are consulted.
 */
export function resolveLlmProviderApiKey(
  entry: UserLlmProviderEntry,
): string | undefined {
  if (entry.apiKey && entry.apiKey.length > 0) {
    return entry.apiKey;
  }
  // Entries created from a known-service preset carry their own env var
  // (`GROQ_API_KEY`, `NOUS_API_KEY`, ...). It is authoritative, without
  // a fallback to the shared per-kind variables: falling through would
  // recreate the wrong-key-for-this-endpoint pairing presets exist to
  // prevent (#69), and keyless local servers (LM Studio) rely on the
  // `undefined` here to send requests without an Authorization header.
  if (entry.apiKeyEnvVar && entry.apiKeyEnvVar.length > 0) {
    const key = process.env[entry.apiKeyEnvVar];
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "aimlapi") {
    const key = process.env.AIMLAPI_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (
    entry.kind === "openai-compatible" ||
    entry.kind === "qwen-openai-compatible"
  ) {
    // ATO-1066: a server on another computer on this network gets only
    // its own stored key. The shared variables usually hold the
    // operator's real OpenAI key, and sending that as a Bearer over
    // plain http:// to a box on the LAN would leak it.
    if (isOtherComputerOnNetworkUrl(entry.baseUrl)) return undefined;
    // `OPENAI_COMPAT_API_KEY` is the variable people set for compat
    // servers on purpose, so it still goes to any of them. The OpenAI
    // variables (ATO-1703) go only to OpenAI itself or this machine: a
    // config.json from somewhere else could otherwise name its own server
    // as `baseUrl` and receive the operator's real OpenAI key.
    const key =
      process.env.OPENAI_COMPAT_API_KEY ??
      (mayReceiveOpenAiKey(entry.baseUrl)
        ? (process.env.OPENAI_API_KEY ??
          process.env.ATOMIC_AGENT_OPENAI_API_KEY)
        : undefined);
    return key && key.length > 0 ? key : undefined;
  }
  return undefined;
}

const OPENAI_ORIGIN = "https://api.openai.com";

/**
 * ATO-1703: whether `OPENAI_API_KEY` / `ATOMIC_AGENT_OPENAI_API_KEY` may be
 * sent to a compat entry's `baseUrl`. Only OpenAI's own API and servers on
 * this machine qualify; no `baseUrl` means the provider's built-in default,
 * which is not a host a config file chose. Anything unparsable gets nothing.
 */
export function mayReceiveOpenAiKey(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.length === 0) return true;
  if (isLocalProviderUrl(baseUrl)) return true;
  try {
    return new URL(baseUrl).origin === OPENAI_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The values of an entry's `extraApiKeyEnvVars` (ATO-471), read the way
 * `apiKeyEnvVar` is: from `process.env`, which bootstrap fills from
 * `<stateDir>/.env`. config.json holds only the names. Unset or blank
 * variables are skipped; order is kept, repeats are dropped.
 */
export function resolveExtraApiKeys(
  entry: { readonly extraApiKeyEnvVars?: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  const names = entry.extraApiKeyEnvVars;
  // Defensive: a hand-edited runtime entry may carry a non-array here.
  if (!Array.isArray(names)) return out;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    const key = env[name]?.trim();
    if (key && key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}
