import { listAimlapiChatPicks } from "../../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js";
import {
  AIMLAPI_DEFAULT_CHAT_MODEL,
  AIMLAPI_MODELS_CATALOG,
} from "../../llm/provider/aimlapi/aimlapi-models-catalog.js";
import { listOpenRouterChatPicks } from "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { OPENROUTER_MODELS_CATALOG } from "../../llm/provider/openrouter/openrouter-models-catalog.js";
import type { ModelCatalogEntry } from "../../llm/provider/model-resolver.js";

export type ProviderModelOption = {
  id: string;
  label: string;
};

/** Sentinel row: keep hybrid recall on the local embedding daemon. */
export const LOCAL_EMBEDDING_CHOICE_ID = "__local_embedding__";

export const OPENROUTER_DEFAULT_CHAT_MODEL = "openrouter/auto";

export const OPENAI_COMPAT_DEFAULT_BASE_URL = "https://api.openai.com";
export const OPENAI_COMPAT_DEFAULT_CHAT_MODEL = "gpt-5.4-mini";

export { AIMLAPI_DEFAULT_CHAT_MODEL };

export function listOpenRouterChatModels(): readonly ProviderModelOption[] {
  return listOpenRouterChatPicks().map((p) => ({
    id: p.id,
    label: `${p.id} · ${formatOpenRouterChatModelDetails(p.id)}`,
  }));
}

export function formatOpenRouterChatModelDetails(modelId: string): string {
  const entry = resolveOpenRouterCatalogEntry(modelId);
  if (!entry || entry.kind !== "chat") return "metadata unavailable";
  return [
    formatContextWindow(entry.contextWindow),
    formatTokenPrice(modelId, entry.pricing),
    formatCapabilitySummary(entry),
  ].join(" · ");
}

export function formatOpenRouterEmbeddingModelDetails(modelId: string): string {
  const entry = OPENROUTER_MODELS_CATALOG.get(modelId);
  if (!entry || entry.kind !== "embedding") return "metadata unavailable";
  const dim = entry.dim !== undefined ? `${entry.dim}d` : "dim?";
  return [
    formatContextWindow(entry.contextWindow),
    dim,
    formatEmbeddingTokenPrice(entry.pricing),
  ].join(" · ");
}

export function listOpenRouterEmbeddingModels(): readonly ProviderModelOption[] {
  const out: ProviderModelOption[] = [
    {
      id: LOCAL_EMBEDDING_CHOICE_ID,
      label: "Local embedding daemon (llama-server, recommended)",
    },
  ];
  for (const [id, entry] of OPENROUTER_MODELS_CATALOG) {
    if (entry.kind !== "embedding") continue;
    out.push({ id, label: `${id} · ${formatOpenRouterEmbeddingModelDetails(id)}` });
  }
  return out;
}

export function listAimlapiChatModels(): readonly ProviderModelOption[] {
  return listAimlapiChatPicks().map((p) => ({
    id: p.id,
    label: `${p.id} · ${formatAimlapiChatModelDetails(p.id)}`,
  }));
}

export function formatAimlapiChatModelDetails(modelId: string): string {
  const entry = resolveAimlapiCatalogEntry(modelId);
  if (!entry || entry.kind !== "chat") return "metadata unavailable";
  return [
    formatContextWindow(entry.contextWindow),
    formatTokenPrice(modelId, entry.pricing),
    formatCapabilitySummary(entry),
  ].join(" · ");
}

export function formatAimlapiEmbeddingModelDetails(modelId: string): string {
  const entry = AIMLAPI_MODELS_CATALOG.get(modelId);
  if (!entry || entry.kind !== "embedding") return "metadata unavailable";
  const dim = entry.dim !== undefined ? `${entry.dim}d` : "dim?";
  return [
    formatContextWindow(entry.contextWindow),
    dim,
    formatEmbeddingTokenPrice(entry.pricing),
  ].join(" · ");
}

export function listAimlapiEmbeddingModels(): readonly ProviderModelOption[] {
  const out: ProviderModelOption[] = [
    {
      id: LOCAL_EMBEDDING_CHOICE_ID,
      label: "Local embedding daemon (llama-server, recommended)",
    },
  ];
  for (const [id, entry] of AIMLAPI_MODELS_CATALOG) {
    if (entry.kind !== "embedding") continue;
    out.push({ id, label: `${id} · ${formatAimlapiEmbeddingModelDetails(id)}` });
  }
  return out;
}

function resolveAimlapiCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  const live = listAimlapiChatPicks().find((pick) => pick.id === modelId)?.entry;
  return live ?? AIMLAPI_MODELS_CATALOG.get(modelId);
}

function resolveOpenRouterCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  const live = listOpenRouterChatPicks().find((pick) => pick.id === modelId)?.entry;
  return live ?? OPENROUTER_MODELS_CATALOG.get(modelId);
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${formatCompactNumber(millions)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

function formatTokenPrice(
  modelId: string,
  pricing: ModelCatalogEntry["pricing"],
): string {
  if (!pricing) return "price unknown";
  if (modelId === "openrouter/auto") return "routed";
  if (pricing.input === 0 && pricing.output === 0) return "free";
  return `$${formatPrice(pricing.input)}/$${formatPrice(pricing.output)}`;
}

function formatEmbeddingTokenPrice(pricing: ModelCatalogEntry["pricing"]): string {
  if (!pricing) return "$?";
  if (pricing.input === 0) return "free";
  return `$${formatPrice(pricing.input)}`;
}

function formatCapabilitySummary(entry: ModelCatalogEntry): string {
  const modality = entry.supportsVision ? "vision" : "text";
  const tools = entry.supportsTools === "none" ? null : "tools";
  const cache = entry.supportsPromptCache ? "cache" : null;
  return [modality, tools, cache].filter(Boolean).join(" · ");
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatPrice(value: number): string {
  if (value === 0) return "0";
  if (value < 1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
