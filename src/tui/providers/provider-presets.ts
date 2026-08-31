/**
 * Known OpenAI-compatible endpoints, so the operator picks a name
 * instead of typing a base URL from memory.
 *
 * These are not new provider kinds: every preset resolves to the
 * existing `openai-compatible` kind with `baseUrl` filled in. Model
 * lists still come from the server's own `/v1/models` (#31, #41), so
 * nothing here needs updating when a vendor ships a new model.
 *
 * ## Admission bar for a new preset
 *
 * Probe `<baseUrl>/v1/models` **with the exact headers this preset will
 * send** — the `apiKeyHeader` and `headers` below, not a bare
 * `Authorization: Bearer` — and accept only one of:
 *
 * 1. **200 with a `data` array.** Keyless listing; nothing left to prove.
 * 2. **401/403 that rejects the *credential*,** with a bogus key of the
 *    right shape in place. The body must complain about the key
 *    (`API key is invalid`), never about the request's shape.
 *
 * A 401 whose body names a header the preset does not send — Anthropic's
 * `x-api-key header is required`, a missing mandatory version header, an
 * "invalid bearer token" for what is an API key and not an OAuth token —
 * is a **failing** probe, not a passing one. It proves the path exists
 * and the auth is wrong, which is the exact condition that must keep a
 * preset out. Fix `apiKeyHeader`/`headers` until the body talks about the
 * key instead, or drop the preset. (Anthropic shipped under the old
 * wording, which read any 401 as "asking for a key": it was asking for a
 * header we never sent, and the preset could not authenticate at all.)
 *
 * Both branches additionally require the same host to answer **404 for a
 * bogus sibling path** — gateways that reject every request before
 * routing (z.ai, Cohere's compatibility root) prove nothing about
 * `/v1/models` and are deliberately absent. So is anything whose model
 * list does not live under `<root>/v1/models`: DeepInfra serves it at
 * `/v1/openai/models`, which this convention cannot express.
 * Re-verified 2026-08-20.
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
   * Header that carries the API key, for services that do not accept
   * `Authorization: Bearer`. Absent means the OpenAI convention, which is
   * every preset but Anthropic. Rides onto the saved config entry as
   * `apiKeyHeader`, so the next non-Bearer vendor is a data change here
   * rather than a code change.
   */
  readonly apiKeyHeader?: string;
  /**
   * Static headers the service requires on every request (Anthropic's
   * mandatory `anthropic-version`). Copied onto the saved entry's
   * `headers`, which the operator can then edit in `config.json`. Never
   * put a secret here — the key travels in `apiKeyHeader` so it can keep
   * coming from `envVar` instead of being written to config.
   */
  readonly headers?: Readonly<Record<string, string>>;
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
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    // The one preset that is not Bearer-authenticated. `api.anthropic.com`
    // reads `Authorization: Bearer` as an OAuth token and answers
    // "Invalid bearer token" to an `sk-ant-…` API key on every path,
    // including `/v1/models`; the key only ever authenticates as
    // `x-api-key`. `anthropic-version` is mandatory on every request and
    // is the header the API dates its wire format by — pinned, not
    // floating, so a future default cannot silently reshape responses.
    apiKeyHeader: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
    note: "Claude models through Anthropic's OpenAI-compatible endpoint",
  },
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
    id: "hyperbolic",
    label: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz",
    envVar: "HYPERBOLIC_API_KEY",
    note: "open-weight models on rented GPUs",
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
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    baseUrl: "https://api.moonshot.ai",
    envVar: "MOONSHOT_API_KEY",
    note: "Kimi models direct from the vendor",
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
    id: "novita",
    label: "Novita AI",
    baseUrl: "https://api.novita.ai/openai",
    envVar: "NOVITA_API_KEY",
    listsModelsWithoutKey: true,
    note: "hosted open-weight catalog, models listed without a key",
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
    // Known upstream quirk (issue #283): Ollama's serving layer corrupts
    // literal thinking-tag strings (`<think>`/`</think>` and variants)
    // that appear inside message content — silently dropping or mangling
    // them (ollama/ollama#17248, #17617). atomic-agent no longer injects
    // a reasoning prefill into chat-transport prompts, so its own
    // requests are clean, but user text or tool output that happens to
    // contain those literal strings can still be altered server-side
    // until Ollama fixes it. Direct vendor APIs are unaffected.
    note: "hosted Ollama, models listed without a key",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    envVar: "PERPLEXITY_API_KEY",
    note: "Sonar models with live web grounding",
  },
  {
    id: "dashscope",
    label: "Qwen (DashScope)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
    envVar: "DASHSCOPE_API_KEY",
    note: "Qwen models direct from Alibaba Cloud (international endpoint)",
  },
  {
    id: "sambanova",
    label: "SambaNova",
    baseUrl: "https://api.sambanova.ai",
    envVar: "SAMBANOVA_API_KEY",
    listsModelsWithoutKey: true,
    note: "open-weight models on custom silicon; models listed without a key",
  },
  {
    id: "sarvam",
    label: "Sarvam",
    baseUrl: "https://api.sarvam.ai",
    envVar: "SARVAM_API_KEY",
    listsModelsWithoutKey: true,
    note: "Sarvam AI models, OpenAI-compatible; models listed without a key",
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
