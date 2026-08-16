/**
 * Known OpenAI-compatible endpoints, so the operator picks a name
 * instead of typing a base URL from memory.
 *
 * These are not new provider kinds: every preset resolves to the
 * existing `openai-compatible` kind with `baseUrl` filled in. Model
 * lists still come from the server's own `/v1/models` (#31, #41), so
 * nothing here needs updating when a vendor ships a new model.
 *
 * Every URL below was verified live: each answers `/v1/models` with an
 * OpenAI-shaped payload (200 with a `data` array, or 401/403 asking for
 * a key, which confirms the path exists).
 */
export interface ProviderPreset {
  /** Stable id used as the provider entry id when adding. */
  readonly id: string;
  /** Name shown in the wizard list. */
  readonly label: string;
  /**
   * API root handed to the openai-compatible provider, stored the way
   * the repo stores every compat base URL: without the `/v1` suffix,
   * because call sites append `/v1/...` themselves.
   */
  readonly baseUrl: string;
  /**
   * Env var holding this service's API key. Each preset gets its own so
   * connecting a second service cannot overwrite the first one's key,
   * which is what a shared `OPENAI_COMPAT_API_KEY` did.
   */
  readonly envVar: string;
  /**
   * `true` for endpoints that serve a model list without credentials.
   * Saving without a key is allowed for these: the operator can browse
   * models first and paste a key later.
   */
  readonly listsModelsWithoutKey?: boolean;
  /**
   * `true` for servers running on the operator's own machine. No API
   * key exists at all, so the wizard saves with an empty key and
   * requests carry no Authorization header.
   */
  readonly local?: boolean;
  /** One-line hint shown under the label. */
  readonly note?: string;
}

/**
 * Array order is display order: `KIND_ROW_ORDER` in
 * `providers-wizard-phases.ts` renders preset rows exactly as listed
 * here, between the two catalog kinds (OpenRouter, AI/ML API) and the
 * manual openai-compatible entry. Keep the entries sorted
 * alphabetically by `label` (plain code-unit order, no locale) so the
 * list reads predictably; a test enforces this.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai",
    envVar: "CEREBRAS_API_KEY",
    note: "high-throughput inference",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    envVar: "DEEPSEEK_API_KEY",
    note: "DeepSeek models direct from the vendor",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference",
    envVar: "FIREWORKS_API_KEY",
    note: "open-weight models, function calling",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envVar: "GROQ_API_KEY",
    note: "very fast inference on open-weight models",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234",
    envVar: "LMSTUDIO_API_KEY",
    local: true,
    note: "the server LM Studio runs on your machine; no API key needed",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai",
    envVar: "MISTRAL_API_KEY",
    note: "Mistral models direct from the vendor",
  },
  {
    id: "nous",
    label: "Nous Research",
    baseUrl: "https://inference-api.nousresearch.com",
    envVar: "NOUS_API_KEY",
    listsModelsWithoutKey: true,
    note: "open-weight models, 350+ ids listed without a key",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434",
    envVar: "OLLAMA_API_KEY",
    local: true,
    note: "the server `ollama serve` runs on your machine; no API key needed",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com",
    envVar: "OLLAMA_CLOUD_API_KEY",
    listsModelsWithoutKey: true,
    note: "hosted Ollama, models listed without a key",
  },
  {
    id: "sarvam",
    label: "Sarvam",
    baseUrl: "https://api.sarvam.ai",
    envVar: "SARVAM_API_KEY",
    note: "Sarvam AI models with OpenAI-compatible API",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz",
    envVar: "TOGETHER_API_KEY",
    note: "broad open-weight catalog",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai",
    envVar: "XAI_API_KEY",
    note: "Grok models direct from the vendor",
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Preset behind an existing config entry, tolerating the numbered
 * suffixes `suggestPresetEntryId` hands out (`groq-2` is still Groq).
 * Reconfiguring such an entry must keep its service identity: the right
 * env var on the key screen and the same entry id on save.
 */
export function presetForEntryId(
  entryId: string,
): ProviderPreset | undefined {
  const direct = findProviderPreset(entryId);
  if (direct) return direct;
  const suffixed = /^(.+)-\d+$/.exec(entryId);
  return suffixed ? findProviderPreset(suffixed[1]!) : undefined;
}

/**
 * Suggested entry id when adding a preset. Falls back to numbered
 * suffixes so a second Groq key does not collide with the first.
 */
export function suggestPresetEntryId(
  preset: ProviderPreset,
  taken: readonly string[],
): string {
  if (!taken.includes(preset.id)) return preset.id;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${preset.id}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${preset.id}-${Date.now()}`;
}
