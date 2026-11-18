import { cloudPresetForUrl } from "../llm/provider/presets/provider-presets.js";

/**
 * ATO-1073: which key env var NAMES a shared setup may carry. A name is
 * kept only when it is the well-known variable of the service the entry
 * actually talks to (`GROQ_API_KEY` next to `https://api.groq.com/...`),
 * so a bundle cannot point this computer's `OPENAI_API_KEY` at a
 * `baseUrl` the sender chose. Everything else is dropped and listed for
 * the recipient to fill in. The cloud presets are the list; the native
 * kinds and OpenAI itself are added here.
 */
const NATIVE_KINDS: Record<string, { envVar: string; origin: string }> = {
  openrouter: { envVar: "OPENROUTER_API_KEY", origin: "https://openrouter.ai" },
  gemini: { envVar: "GEMINI_API_KEY", origin: "https://generativelanguage.googleapis.com" },
};
const OPENAI_ORIGIN = "https://api.openai.com";

function originOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The one key env var name this provider entry may keep, if any. */
export function knownProviderEnvVar(entry: Record<string, unknown>): string | undefined {
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const origin = originOf(entry.baseUrl);
  const native = NATIVE_KINDS[kind];
  if (native) {
    // No baseUrl means the kind's own endpoint; a custom one must be it.
    if (entry.baseUrl === undefined || origin === native.origin) return native.envVar;
    return undefined;
  }
  if (!origin || typeof entry.baseUrl !== "string") return undefined;
  if (origin === OPENAI_ORIGIN) return "OPENAI_API_KEY";
  return cloudPresetForUrl(entry.baseUrl)?.envVar;
}

/**
 * Remove the key sources a bundle must not bring along from one provider
 * entry (mutated in place): `apiKeyCommand` always, `apiKeyEnvVar` unless
 * it is the known name for the entry's endpoint, and each
 * `extraApiKeyEnvVars` item unless it is that name or a numbered spare of
 * it (`GROQ_API_KEY_2`). Returns the dropped field names.
 */
export function stripUnknownKeySources(entry: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  if ("apiKeyCommand" in entry) {
    delete entry.apiKeyCommand;
    dropped.push("apiKeyCommand");
  }
  const known = knownProviderEnvVar(entry);
  if ("apiKeyEnvVar" in entry && (!known || entry.apiKeyEnvVar !== known)) {
    delete entry.apiKeyEnvVar;
    dropped.push("apiKeyEnvVar");
  }
  if ("extraApiKeyEnvVars" in entry) {
    const extras = entry.extraApiKeyEnvVars;
    const spare = known ? new RegExp(`^${known}(?:_\\d+)?$`) : undefined;
    const kept = Array.isArray(extras)
      ? extras.filter((n): n is string => typeof n === "string" && !!spare?.test(n))
      : [];
    const all = Array.isArray(extras) && kept.length === extras.length;
    if (!all) {
      if (kept.length > 0) entry.extraApiKeyEnvVars = kept;
      else delete entry.extraApiKeyEnvVars;
      dropped.push("extraApiKeyEnvVars");
    }
  }
  return dropped;
}
