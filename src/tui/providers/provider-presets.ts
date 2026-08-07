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
  /** Base URL handed to the openai-compatible provider. */
  readonly baseUrl: string;
  /**
   * `true` for endpoints that serve a model list without credentials.
   * The wizard can then show models before an API key is entered.
   */
  readonly listsModelsWithoutKey?: boolean;
  /** `true` for servers running on the operator's own machine. */
  readonly local?: boolean;
  /** One-line hint shown under the label. */
  readonly note?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "nous",
    label: "Nous Research",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    listsModelsWithoutKey: true,
    note: "open-weight models, 350+ ids listed without a key",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    note: "very fast inference on open-weight models",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    note: "DeepSeek models direct from the vendor",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    note: "broad open-weight catalog",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    note: "open-weight models, function calling",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    note: "high-throughput inference",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    note: "Mistral models direct from the vendor",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    note: "Grok models direct from the vendor",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    listsModelsWithoutKey: true,
    note: "hosted Ollama, models listed without a key",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    note: "the server LM Studio runs on your machine; no API key needed",
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
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
