import type { ModelCatalogEntry } from "../model-resolver.js";
import { chatModel, embeddingModel } from "../model-catalog-entry.js";

/**
 * Static fallback catalog for aimlapi.com.
 *
 * The aimlapi `/v1/models` endpoint exposes every id but NOT pricing,
 * so this map serves three purposes: (1) offline fallback when the
 * live fetch fails; (2) curated TUI ordering via
 * {@link AIMLAPI_CHAT_MODEL_ORDER}; (3) authoritative
 * `contextWindow` / `supportsVision` / `supportsTools` for ids that
 * have been hand-verified against the live API.
 *
 * Curated down to current-generation chat models only: legacy OpenAI
 * (gpt-4o / gpt-4.1 / o-series) and the unprefixed `claude-*` /
 * `google/gemini-2.x` ids stay retired because aimlapi no longer serves
 * them. Claude and Gemini themselves are back — aimlapi lists them under
 * vendor-prefixed ids (`anthropic/claude-opus-5`,
 * `google/gemini-3.7-flash`) on the `openai/chat-completions` surface,
 * so they work through this provider like any other row.
 *
 * Every id here was re-verified on 2026-08-19 against
 * `https://api.aimlapi.com/v1/models` with `type ===
 * "openai/chat-completions"`. Models that only expose `type:
 * "responses"` (`openai/gpt-5-pro`, `openai/gpt-5-3-codex`) or only
 * `anthropic/messages` are intentionally excluded — they 404 on
 * `/v1/chat/completions`.
 */
export const AIMLAPI_MODELS_CATALOG: ReadonlyMap<string, ModelCatalogEntry> =
  new Map<string, ModelCatalogEntry>([
    // OpenAI GPT-5 family (newest verified chat-completion ids)
    chatModel({
      id: "openai/gpt-5.5-2026-04-23",
      contextWindow: 1_050_000,
      supportsVision: true,
    }),
    chatModel({
      id: "openai/gpt-5.4-2026-03-05",
      contextWindow: 1_050_000,
      supportsVision: true,
    }),
    chatModel({
      id: "openai/gpt-5-mini-2025-08-07",
      contextWindow: 400_000,
      supportsVision: true,
      supportsPromptCache: true,
    }),
    chatModel({
      id: "openai/gpt-5-nano-2025-08-07",
      contextWindow: 400_000,
      supportsVision: true,
      supportsPromptCache: true,
    }),
    // OpenAI open-weight (OSS)
    chatModel({
      id: "openai/gpt-oss-120b",
      contextWindow: 131_000,
      supportsVision: false,
    }),
    chatModel({
      id: "openai/gpt-oss-20b",
      contextWindow: 131_000,
      supportsVision: false,
    }),
    // xAI Grok
    chatModel({
      id: "x-ai/grok-4-3",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "x-ai/grok-4-fast-reasoning",
      contextWindow: 2_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "x-ai/grok-4-6",
      contextWindow: 500_000,
      supportsVision: true,
    }),
    // DeepSeek
    chatModel({
      id: "deepseek/deepseek-v4-flash",
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: "basic",
    }),
    chatModel({
      id: "deepseek/deepseek-v4-pro",
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: "basic",
    }),
    // Moonshot Kimi
    chatModel({
      id: "moonshot/kimi-k2-7-code",
      contextWindow: 262_144,
      supportsVision: false,
    }),
    chatModel({
      id: "moonshot/kimi-k3",
      contextWindow: 1_048_576,
      supportsVision: false,
    }),
    // ByteDance Seed
    chatModel({
      id: "bytedance/dola-seed-2-0-pro",
      contextWindow: 256_000,
      supportsVision: true,
    }),
    // MiniMax
    chatModel({
      id: "minimax/minimax-m3",
      contextWindow: 524_288,
      supportsVision: false,
    }),
    // Anthropic Claude (verified `openai/chat-completions`, not the
    // `anthropic/messages` surface that 404s on /v1/chat/completions)
    chatModel({
      id: "anthropic/claude-opus-5",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "anthropic/claude-sonnet-5",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "anthropic/claude-fable-5",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "anthropic/claude-opus-4-8",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "anthropic/claude-haiku-4.5",
      contextWindow: 200_000,
      supportsVision: true,
    }),
    // Google Gemini
    chatModel({
      id: "google/gemini-3.7-flash",
      contextWindow: 1_048_576,
      supportsVision: true,
    }),
    chatModel({
      id: "google/gemini-3.5-flash",
      contextWindow: 1_048_576,
      supportsVision: true,
    }),
    chatModel({
      id: "google/gemini-3.5-flash-lite",
      contextWindow: 1_048_576,
      supportsVision: true,
    }),
    chatModel({
      id: "google/gemini-3.1-pro-preview",
      contextWindow: 1_000_000,
      supportsVision: true,
    }),
    // Alibaba Qwen
    chatModel({
      id: "alibaba/qwen3.8-max",
      contextWindow: 1_000_000,
      supportsVision: false,
    }),
    chatModel({
      id: "alibaba/qwen3.7-max",
      contextWindow: 1_000_000,
      supportsVision: false,
    }),
    chatModel({
      id: "alibaba/qwen3.6-flash",
      contextWindow: 1_000_000,
      supportsVision: false,
    }),
    chatModel({
      id: "alibaba/qwen3-vl-plus",
      contextWindow: 262_144,
      supportsVision: true,
    }),
    // Zhipu GLM
    chatModel({
      id: "zhipu/glm-5-3",
      contextWindow: 1_024_000,
      supportsVision: false,
    }),
    chatModel({
      id: "zhipu/glm-5.2",
      contextWindow: 1_000_000,
      supportsVision: false,
    }),
    // Mistral
    chatModel({
      id: "mistralai/mistral-large-2512",
      contextWindow: 262_144,
      supportsVision: false,
    }),
    chatModel({
      id: "mistralai/mistral-medium-3-5",
      contextWindow: 262_144,
      supportsVision: false,
    }),
    // Embeddings (verified against `/v1/models`)
    embeddingModel({
      id: "text-embedding-3-small",
      contextWindow: 8000,
      dim: 1536,
    }),
    embeddingModel({
      id: "text-embedding-3-large",
      contextWindow: 8000,
      dim: 3072,
    }),
    embeddingModel({
      id: "text-embedding-ada-002",
      contextWindow: 8000,
      dim: 1536,
    }),
    embeddingModel({
      id: "voyage-large-2-instruct",
      contextWindow: 16_000,
    }),
    embeddingModel({
      id: "voyage-multilingual-2",
      contextWindow: 32_000,
    }),
  ]);

/**
 * TUI chat-picker order when offline: catalog order, verified ids only.
 */
export const AIMLAPI_CHAT_MODEL_ORDER: readonly string[] = [
  "openai/gpt-5.5-2026-04-23",
  "openai/gpt-5.4-2026-03-05",
  "openai/gpt-5-mini-2025-08-07",
  "openai/gpt-5-nano-2025-08-07",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "x-ai/grok-4-3",
  "x-ai/grok-4-fast-reasoning",
  "x-ai/grok-4-6",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "moonshot/kimi-k2-7-code",
  "moonshot/kimi-k3",
  "bytedance/dola-seed-2-0-pro",
  "minimax/minimax-m3",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.7-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-pro-preview",
  "alibaba/qwen3.8-max",
  "alibaba/qwen3.7-max",
  "alibaba/qwen3.6-flash",
  "alibaba/qwen3-vl-plus",
  "zhipu/glm-5-3",
  "zhipu/glm-5.2",
  "mistralai/mistral-large-2512",
  "mistralai/mistral-medium-3-5",
];

/**
 * Default chat model: `openai/gpt-5.5-2026-04-23` — newest GPT-5.5 with
 * ~1.05M context, parallel tools + vision, available on
 * `/v1/chat/completions`.
 */
export const AIMLAPI_DEFAULT_CHAT_MODEL = "openai/gpt-5.5-2026-04-23";
