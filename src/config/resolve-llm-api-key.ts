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
    const key =
      process.env.OPENAI_COMPAT_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.ATOMIC_AGENT_OPENAI_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  return undefined;
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
