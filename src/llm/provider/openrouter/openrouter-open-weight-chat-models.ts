import { chatModel, type CatalogRow } from "../model-catalog-entry.js";

/**
 * Open-weight chat models on OpenRouter — families whose weights are
 * published, served here by whichever provider OpenRouter routes to.
 *
 * Same provenance as the frontier list: generated from
 * `https://openrouter.ai/api/v1/models` on 2026-08-19, curated to the
 * current generation of each family, `tools`-capable only.
 */
export const OPENROUTER_OPEN_WEIGHT_CHAT_MODELS: readonly CatalogRow[] = [
    // Qwen
    chatModel({
      id: "qwen/qwen3.8-max",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 6 },
    }),
    chatModel({
      id: "qwen/qwen3.8-2.4t-a95b",
      contextWindow: 1_048_576,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 2, output: 6 },
    }),
    chatModel({
      id: "qwen/qwen3.8-27b",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.45, output: 3.2 },
    }),
    chatModel({
      id: "qwen/qwen3.7-max",
      contextWindow: 1_000_000,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 1.475, output: 4.425 },
    }),
    chatModel({
      id: "qwen/qwen3.7-plus",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.32, output: 1.28 },
    }),
    chatModel({
      id: "qwen/qwen3.7-flash",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.03, output: 0.13 },
    }),
    chatModel({
      id: "qwen/qwen3.6-35b-a3b",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.14, output: 1 },
    }),
    chatModel({
      id: "qwen/qwen3.6-flash",
      contextWindow: 1_000_000,
      supportsVision: true,
      pricing: { input: 0.188, output: 1.125 },
    }),
    chatModel({
      id: "qwen/qwen3-coder-plus",
      contextWindow: 1_000_000,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.65, output: 3.25 },
    }),
    // DeepSeek
    chatModel({
      id: "deepseek/deepseek-v4-pro",
      contextWindow: 1_048_576,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.66, output: 1.98 },
    }),
    chatModel({
      id: "deepseek/deepseek-v4-flash",
      contextWindow: 1_048_576,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.083, output: 0.165 },
    }),
    // Moonshot AI — Kimi
    chatModel({
      id: "moonshotai/kimi-k3",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 3, output: 15 },
    }),
    chatModel({
      id: "moonshotai/kimi-k2.7-code",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.71, output: 3.5 },
    }),
    chatModel({
      id: "moonshotai/kimi-k2.6",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.95, output: 4 },
    }),
    // Z.ai — GLM
    chatModel({
      id: "z-ai/glm-5.3",
      contextWindow: 1_048_576,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 1.4, output: 4.4 },
    }),
    chatModel({
      id: "z-ai/glm-5.2",
      contextWindow: 1_048_576,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.966, output: 3.036 },
    }),
    chatModel({
      id: "z-ai/glm-5.1",
      contextWindow: 204_800,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.966, output: 3.036 },
    }),
    chatModel({
      id: "z-ai/glm-4.7-flash",
      contextWindow: 202_752,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.06, output: 0.4 },
    }),
    // MiniMax
    chatModel({
      id: "minimax/minimax-m3",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.3, output: 1.2 },
    }),
    chatModel({
      id: "minimax/minimax-m2.7",
      contextWindow: 204_800,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.3, output: 1.2 },
    }),
    // Mistral
    chatModel({
      id: "mistralai/mistral-large-2512",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.5, output: 1.5 },
    }),
    chatModel({
      id: "mistralai/mistral-medium-3-5",
      contextWindow: 262_144,
      supportsVision: true,
      pricing: { input: 1.5, output: 7.5 },
    }),
    chatModel({
      id: "mistralai/ministral-8b-2512",
      contextWindow: 262_144,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.15, output: 0.15 },
    }),
    // Meta — Llama
    chatModel({
      id: "meta-llama/llama-4-maverick",
      contextWindow: 1_048_576,
      supportsVision: true,
      pricing: { input: 0.2, output: 0.8 },
    }),
    chatModel({
      id: "meta-llama/llama-4-scout",
      contextWindow: 1_310_720,
      supportsVision: true,
      pricing: { input: 0.1, output: 0.3 },
    }),
    chatModel({
      id: "meta-llama/llama-3.3-70b-instruct",
      contextWindow: 131_072,
      supportsVision: false,
      pricing: { input: 0.1, output: 0.32 },
    }),
    // OpenAI gpt-oss (open weights)
    chatModel({
      id: "openai/gpt-oss-120b",
      contextWindow: 131_072,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.03, output: 0.17 },
    }),
    chatModel({
      id: "openai/gpt-oss-20b",
      contextWindow: 131_072,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.03, output: 0.13 },
    }),
    // NVIDIA — Nemotron
    chatModel({
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      contextWindow: 512_288,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.6, output: 3.6 },
    }),
    chatModel({
      id: "nvidia/nemotron-3.5-lightning",
      contextWindow: 1_000_000,
      supportsVision: false,
      supportsPromptCache: true,
      pricing: { input: 0.08, output: 0.2 },
    }),
    // Amazon — Nova
    chatModel({
      id: "amazon/nova-premier-v1",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2.5, output: 12.5 },
    }),
    chatModel({
      id: "amazon/nova-2-lite-v1",
      contextWindow: 1_000_000,
      supportsVision: true,
      pricing: { input: 0.3, output: 2.5 },
    }),
    // ByteDance — Seed
    chatModel({
      id: "bytedance-seed/seed-2.0-code",
      contextWindow: 262_144,
      supportsVision: true,
      pricing: { input: 0.5, output: 3 },
    }),];
