import type { ModelCatalogEntry } from "../model-resolver.js";

type Price = { input: number; output: number };

type ChatModelSpec = {
  id: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsPromptCache?: boolean;
  pricing: Price;
};

type EmbeddingModelSpec = ChatModelSpec & {
  dim: number;
};

function chatModel(spec: ChatModelSpec): readonly [string, ModelCatalogEntry] {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "chat",
      contextWindow: spec.contextWindow,
      supportsVision: spec.supportsVision,
      supportsTools: "parallel",
      supportsPromptCache: spec.supportsPromptCache ?? false,
      reasoningFormat: "none",
      pricing: spec.pricing,
    },
  ];
}

function embeddingModel(spec: EmbeddingModelSpec): readonly [string, ModelCatalogEntry] {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "embedding",
      contextWindow: spec.contextWindow,
      dim: spec.dim,
      supportsVision: false,
      supportsTools: "none",
      supportsPromptCache: spec.supportsPromptCache ?? false,
      reasoningFormat: "none",
      pricing: spec.pricing,
    },
  ];
}

/**
 * Static fallback catalog (May 2026 OpenRouter slugs). The TUI wizard
 * prefers {@link refreshOpenRouterChatCatalogFromApi} when online; this
 * map backs offline runs and `resolveModel` metadata.
 */
export const OPENROUTER_MODELS_CATALOG: ReadonlyMap<string, ModelCatalogEntry> =
  new Map<string, ModelCatalogEntry>([
    chatModel({
      id: "openrouter/auto",
      contextWindow: 2_000_000,
      supportsVision: true,
      pricing: { input: 0, output: 0 },
    }),
    chatModel({
      id: "qwen/qwen3.7-max",
      contextWindow: 1_000_000,
      supportsVision: false,
      pricing: { input: 2.5, output: 7.5 },
    }),
    chatModel({
      id: "qwen/qwen3.6-35b-a3b",
      contextWindow: 262_144,
      supportsVision: true,
      pricing: { input: 0.15, output: 1 },
    }),
    chatModel({
      id: "qwen/qwen3.6-flash",
      contextWindow: 1_000_000,
      supportsVision: true,
      pricing: { input: 0.19, output: 1.13 },
    }),
    chatModel({
      id: "openai/gpt-5.5",
      contextWindow: 1_050_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 5, output: 30 },
    }),
    chatModel({
      id: "openai/gpt-5.4",
      contextWindow: 1_050_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2.5, output: 15 },
    }),
    chatModel({
      id: "openai/gpt-5.4-mini",
      contextWindow: 400_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.75, output: 4.5 },
    }),
    chatModel({
      id: "openai/gpt-5.4-nano",
      contextWindow: 400_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.2, output: 1.25 },
    }),
    chatModel({
      id: "x-ai/grok-4.3",
      contextWindow: 1_000_000,
      supportsVision: true,
      pricing: { input: 1.25, output: 2.5 },
    }),
    chatModel({
      id: "deepseek/deepseek-v4-flash:free",
      contextWindow: 1_048_576,
      supportsVision: false,
      pricing: { input: 0, output: 0 },
    }),
    chatModel({
      id: "deepseek/deepseek-v4-flash",
      contextWindow: 1_048_576,
      supportsVision: false,
      pricing: { input: 0.1, output: 0.2 },
    }),
    chatModel({
      id: "moonshotai/kimi-k2.6",
      contextWindow: 262_144,
      supportsVision: true,
      pricing: { input: 0.73, output: 3.49 },
    }),
    chatModel({
      id: "mistralai/mistral-medium-3-5",
      contextWindow: 262_144,
      supportsVision: true,
      pricing: { input: 1.5, output: 7.5 },
    }),
    chatModel({
      id: "minimax/minimax-m3",
      contextWindow: 1_000_000,
      supportsVision: true,
      pricing: { input: 0.3, output: 1.2 },
    }),
    chatModel({
      id: "minimax/minimax-m2.7",
      contextWindow: 204_800,
      supportsVision: false,
      pricing: { input: 0.28, output: 1.2 },
    }),
    chatModel({
      id: "z-ai/glm-4.7-flash",
      contextWindow: 202_752,
      supportsVision: false,
      pricing: { input: 0.06, output: 0.4 },
    }),
    chatModel({
      id: "z-ai/glm-5",
      contextWindow: 202_752,
      supportsVision: false,
      pricing: { input: 0.6, output: 1.92 },
    }),
    embeddingModel({
      id: "openai/text-embedding-3-small",
      contextWindow: 8192,
      dim: 1536,
      supportsVision: false,
      pricing: { input: 0.02, output: 0 },
    }),
    embeddingModel({
      id: "openai/text-embedding-3-large",
      contextWindow: 8192,
      dim: 3072,
      supportsVision: false,
      pricing: { input: 0.13, output: 0 },
    }),
  ]);

/** Static TUI order when the live API fetch is unavailable. */
export const OPENROUTER_CHAT_MODEL_ORDER: readonly string[] = [
  "openrouter/auto",
  "qwen/qwen3.7-max",
  "qwen/qwen3.6-35b-a3b",
  "qwen/qwen3.6-flash",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "x-ai/grok-4.3",
  "deepseek/deepseek-v4-flash:free",
  "deepseek/deepseek-v4-flash",
  "moonshotai/kimi-k2.6",
  "mistralai/mistral-medium-3-5",
  "minimax/minimax-m3",
  "minimax/minimax-m2.7",
  "z-ai/glm-4.7-flash",
  "z-ai/glm-5",
];
