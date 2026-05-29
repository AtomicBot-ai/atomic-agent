import type { ModelCatalogEntry } from "../model-resolver.js";

type ChatModelSpec = {
  id: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools?: "basic" | "parallel";
  supportsPromptCache?: boolean;
};

type EmbeddingModelSpec = {
  id: string;
  contextWindow: number;
  dim?: number;
};

function chatModel(spec: ChatModelSpec): readonly [string, ModelCatalogEntry] {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "chat",
      contextWindow: spec.contextWindow,
      supportsVision: spec.supportsVision,
      supportsTools: spec.supportsTools ?? "parallel",
      supportsPromptCache: spec.supportsPromptCache ?? false,
      reasoningFormat: "none",
    },
  ];
}

function embeddingModel(
  spec: EmbeddingModelSpec,
): readonly [string, ModelCatalogEntry] {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "embedding",
      contextWindow: spec.contextWindow,
      ...(spec.dim !== undefined ? { dim: spec.dim } : {}),
      supportsVision: false,
      supportsTools: "none",
      supportsPromptCache: false,
      reasoningFormat: "none",
    },
  ];
}

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
 * Curated down to current-generation chat models only — legacy OpenAI
 * (gpt-4o / gpt-4.1 / o-series), all Anthropic Claude, and all Google
 * Gemini ids were retired. Every id here was verified against
 * `https://api.aimlapi.com/v1/models` with `type === "chat-completion"`.
 * Models that only expose `type: "responses"` (`openai/gpt-5-pro`,
 * `openai/gpt-5-3-codex`, etc.) are intentionally excluded — they 404
 * on `/v1/chat/completions`.
 */
export const AIMLAPI_MODELS_CATALOG: ReadonlyMap<string, ModelCatalogEntry> =
  new Map<string, ModelCatalogEntry>([
    // OpenAI GPT-5 family (newest verified chat-completion ids)
    chatModel({
      id: "openai/gpt-5-2",
      contextWindow: 400_000,
      supportsVision: true,
    }),
    chatModel({
      id: "openai/gpt-5-1",
      contextWindow: 400_000,
      supportsVision: true,
    }),
    chatModel({
      id: "openai/gpt-5-2-chat-latest",
      contextWindow: 128_000,
      supportsVision: true,
      supportsPromptCache: true,
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
      id: "x-ai/grok-4-1-fast-reasoning",
      contextWindow: 2_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "x-ai/grok-4-1-fast-non-reasoning",
      contextWindow: 2_000_000,
      supportsVision: true,
    }),
    chatModel({
      id: "x-ai/grok-4-fast-reasoning",
      contextWindow: 2_000_000,
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
      id: "moonshot/kimi-k2-6",
      contextWindow: 131_000,
      supportsVision: false,
    }),
    // ByteDance Seed
    chatModel({
      id: "bytedance/seed-1-8",
      contextWindow: 256_000,
      supportsVision: true,
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

/** TUI chat-picker order when offline. Verified ids only. */
export const AIMLAPI_CHAT_MODEL_ORDER: readonly string[] = [
  "openai/gpt-5-2",
  "openai/gpt-5-1",
  "openai/gpt-5-2-chat-latest",
  "openai/gpt-5-mini-2025-08-07",
  "openai/gpt-5-nano-2025-08-07",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "x-ai/grok-4-1-fast-reasoning",
  "x-ai/grok-4-1-fast-non-reasoning",
  "x-ai/grok-4-fast-reasoning",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "moonshot/kimi-k2-6",
  "bytedance/seed-1-8",
];

/**
 * Default chat model: `openai/gpt-5-2` — newest GPT-5.2 with 400k
 * context, parallel tools + vision, available on `/v1/chat/completions`.
 */
export const AIMLAPI_DEFAULT_CHAT_MODEL = "openai/gpt-5-2";
