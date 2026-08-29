import { chatModel, type CatalogRow } from "../model-catalog-entry.js";

/**
 * Hosted frontier chat models on OpenRouter — the vendors that only ship
 * behind an API.
 *
 * Generated from `https://openrouter.ai/api/v1/models` on 2026-08-19 and
 * hand-curated down to the current generation of each family: every row's
 * `contextWindow`, `supportsVision` (`architecture.input_modalities`
 * contains `image`), `supportsPromptCache` (`pricing.input_cache_read` is
 * published) and `pricing` (USD per 1M tokens) comes from that response,
 * and every id advertises `tools` in `supported_parameters`.
 *
 * Anthropic and Gemini rows live here because they are no longer filtered
 * out — see the note on `scoreChat` in `fetch-openrouter-chat-catalog.ts`.
 */
export const OPENROUTER_FRONTIER_CHAT_MODELS: readonly CatalogRow[] = [
    // Anthropic — Claude 5 / 4.8
    chatModel({
      id: "anthropic/claude-opus-5",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 5, output: 25 },
    }),
    chatModel({
      id: "anthropic/claude-opus-5-fast",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 10, output: 50 },
    }),
    chatModel({
      id: "anthropic/claude-sonnet-5",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 10 },
    }),
    chatModel({
      id: "anthropic/claude-fable-5",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 10, output: 50 },
    }),
    chatModel({
      id: "anthropic/claude-opus-4.8",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 5, output: 25 },
    }),
    chatModel({
      id: "anthropic/claude-haiku-4.5",
      contextWindow: 200_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 1, output: 5 },
    }),
    // Google — Gemini 3.x
    chatModel({
      id: "google/gemini-3.7-flash",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.375, output: 1.875 },
    }),
    chatModel({
      id: "google/gemini-3.6-flash",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.75, output: 3.75 },
    }),
    chatModel({
      id: "google/gemini-3.5-flash",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 1.5, output: 9 },
    }),
    chatModel({
      id: "google/gemini-3.5-flash-lite",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.3, output: 2.5 },
    }),
    chatModel({
      id: "google/gemini-3.1-pro-preview",
      contextWindow: 1_048_576,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 12 },
    }),
    // OpenAI — GPT-5.x
    chatModel({
      id: "openai/gpt-5.6-sol",
      contextWindow: 1_050_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2.5, output: 15 },
    }),
    chatModel({
      id: "openai/gpt-5.6-terra",
      contextWindow: 1_050_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 12 },
    }),
    chatModel({
      id: "openai/gpt-5.6-luna",
      contextWindow: 1_050_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 0.2, output: 1.2 },
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
    // xAI — Grok 4.x
    chatModel({
      id: "x-ai/grok-4.6",
      contextWindow: 500_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 6 },
    }),
    chatModel({
      id: "x-ai/grok-4.5",
      contextWindow: 500_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 2, output: 6 },
    }),
    chatModel({
      id: "x-ai/grok-4.3",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPromptCache: true,
      pricing: { input: 1.25, output: 2.5 },
    }),];
