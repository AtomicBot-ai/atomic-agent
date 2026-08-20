import type { ModelCatalogEntry } from "../model-resolver.js";
import { embeddingModel } from "../model-catalog-entry.js";
import { OPENROUTER_FRONTIER_CHAT_MODELS } from "./openrouter-frontier-chat-models.js";
import { OPENROUTER_OPEN_WEIGHT_CHAT_MODELS } from "./openrouter-open-weight-chat-models.js";

/**
 * Static fallback catalog, regenerated from the public OpenRouter model
 * list on 2026-08-19. The TUI wizard prefers
 * {@link refreshOpenRouterChatCatalogFromApi} when online; this map backs
 * offline runs and `resolveModel` metadata (context window, capabilities,
 * price per 1M tokens).
 *
 * The chat rows live in two sibling files — hosted frontier models and
 * open-weight ones — to stay inside the 300-line limit. Embedding rows
 * stay here; there are two of them and OpenRouter has not changed their
 * pricing since the previous snapshot.
 */
export const OPENROUTER_MODELS_CATALOG: ReadonlyMap<string, ModelCatalogEntry> =
  new Map<string, ModelCatalogEntry>([
    [
      "openrouter/auto",
      {
        id: "openrouter/auto",
        kind: "chat",
        contextWindow: 2_000_000,
        supportsVision: true,
        supportsTools: "parallel",
        supportsPromptCache: false,
        reasoningFormat: "none",
        // Routed: the price is whatever model OpenRouter picks.
        pricing: { input: 0, output: 0 },
      },
    ],
    ...OPENROUTER_FRONTIER_CHAT_MODELS,
    ...OPENROUTER_OPEN_WEIGHT_CHAT_MODELS,
    embeddingModel({
      id: "openai/text-embedding-3-small",
      contextWindow: 8192,
      dim: 1536,
      pricing: { input: 0.02, output: 0 },
    }),
    embeddingModel({
      id: "openai/text-embedding-3-large",
      contextWindow: 8192,
      dim: 3072,
      pricing: { input: 0.13, output: 0 },
    }),
  ]);

/**
 * Static TUI order when the live API fetch is unavailable: the curated
 * catalog order, `openrouter/auto` first.
 */
export const OPENROUTER_CHAT_MODEL_ORDER: readonly string[] = [
  "openrouter/auto",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-fast",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-pro-preview",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "x-ai/grok-4.6",
  "x-ai/grok-4.5",
  "x-ai/grok-4.3",
  "qwen/qwen3.8-max",
  "qwen/qwen3.8-2.4t-a95b",
  "qwen/qwen3.8-27b",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "qwen/qwen3.7-flash",
  "qwen/qwen3.6-35b-a3b",
  "qwen/qwen3.6-flash",
  "qwen/qwen3-coder-plus",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.3",
  "z-ai/glm-5.2",
  "z-ai/glm-5.1",
  "z-ai/glm-4.7-flash",
  "minimax/minimax-m3",
  "minimax/minimax-m2.7",
  "mistralai/mistral-large-2512",
  "mistralai/mistral-medium-3-5",
  "mistralai/ministral-8b-2512",
  "meta-llama/llama-4-maverick",
  "meta-llama/llama-4-scout",
  "meta-llama/llama-3.3-70b-instruct",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning",
  "amazon/nova-premier-v1",
  "amazon/nova-2-lite-v1",
  "bytedance-seed/seed-2.0-code",];
