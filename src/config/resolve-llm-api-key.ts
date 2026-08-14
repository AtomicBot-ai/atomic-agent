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
  // Local Ollama needs no key; OLLAMA_API_KEY only matters when the
  // entry points at ollama.com, and `undefined` keeps requests bare.
  if (entry.kind === "ollama") {
    const key = process.env.OLLAMA_API_KEY;
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
