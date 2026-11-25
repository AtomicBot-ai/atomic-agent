import { isOtherComputerOnNetworkUrl } from "../llm/provider/openai/network-server-address.js";
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
    // ATO-1703: naming `OPENAI_API_KEY` here is no way around the rule
    // below; a config.json from elsewhere could carry exactly that.
    if (!mayUseKeyVariable(entry, entry.apiKeyEnvVar)) return undefined;
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

/** The variables that usually hold the operator's real OpenAI key (ATO-1703). */
export const OPENAI_KEY_VARIABLES: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
]);

/**
 * ATO-1703: whether `OPENAI_API_KEY` / `ATOMIC_AGENT_OPENAI_API_KEY` may be
 * sent to a compat entry's `baseUrl`. Only OpenAI's own API and this
 * machine qualify, by literal loopback address: a `*.localhost` name can
 * still be answered by the network's DNS. No `baseUrl` answers `true`: the
 * compat providers refuse to start without one, so nothing is sent, and
 * callers that look a key up before the address is known keep working.
 * Anything unparsable gets nothing.
 */
export function mayReceiveOpenAiKey(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.length === 0) return true;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.origin === OPENAI_ORIGIN) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether `entry` may read its key from the variable `name`. Only the
 * OpenAI variables are restricted: they go to OpenAI or this machine, and
 * never to a native kind (OpenRouter, Gemini, ...), whose host is not OpenAI.
 */
function mayUseKeyVariable(
  entry: { readonly kind?: string; readonly baseUrl?: string },
  name: string,
): boolean {
  if (!OPENAI_KEY_VARIABLES.has(name)) return true;
  if (entry.baseUrl !== undefined && entry.baseUrl.length > 0) {
    return mayReceiveOpenAiKey(entry.baseUrl);
  }
  return (
    entry.kind === undefined ||
    entry.kind === "openai-compatible" ||
    entry.kind === "qwen-openai-compatible"
  );
}

/**
 * The values of an entry's `extraApiKeyEnvVars` (ATO-471), read the way
 * `apiKeyEnvVar` is: from `process.env`, which bootstrap fills from
 * `<stateDir>/.env`. config.json holds only the names. Unset or blank
 * variables are skipped; order is kept, repeats are dropped.
 */
export function resolveExtraApiKeys(
  entry: {
    readonly extraApiKeyEnvVars?: readonly string[];
    readonly kind?: string;
    readonly baseUrl?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  options: {
    /**
     * `false` reads every named variable, the OpenAI ones included, for
     * callers that only mask values in output and never send them.
     */
    readonly scopeOpenAiKey?: boolean;
  } = {},
): string[] {
  const out: string[] = [];
  const names = entry.extraApiKeyEnvVars;
  // Defensive: a hand-edited runtime entry may carry a non-array here.
  if (!Array.isArray(names)) return out;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    // ATO-1703: the same rule as `apiKeyEnvVar`.
    if (options.scopeOpenAiKey !== false && !mayUseKeyVariable(entry, name)) {
      continue;
    }
    const key = env[name]?.trim();
    if (key && key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}
