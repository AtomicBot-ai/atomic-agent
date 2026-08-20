import type { ModelCatalogEntry } from "./model-resolver.js";

/**
 * How a catalog row is described to a human: context window, price per
 * 1M tokens, capability summary.
 *
 * Lifted out of `src/tui/providers/providers-model-options.ts` so the
 * `models search` CLI prints the same strings as the TUI picker without
 * a CLI -> TUI import. `src/llm/` is the layer both frontends already
 * depend on.
 */

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${formatCompactNumber(millions)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

export function formatTokenPrice(
  modelId: string,
  pricing: ModelCatalogEntry["pricing"],
): string {
  if (!pricing) return "price unknown";
  if (modelId === "openrouter/auto") return "routed";
  if (pricing.input === 0 && pricing.output === 0) return "free";
  return `$${formatPrice(pricing.input)}/$${formatPrice(pricing.output)}`;
}

export function formatEmbeddingTokenPrice(
  pricing: ModelCatalogEntry["pricing"],
): string {
  if (!pricing) return "$?";
  if (pricing.input === 0) return "free";
  return `$${formatPrice(pricing.input)}`;
}

export function formatCapabilitySummary(entry: ModelCatalogEntry): string {
  const modality = entry.supportsVision ? "vision" : "text";
  const tools = entry.supportsTools === "none" ? null : "tools";
  const cache = entry.supportsPromptCache ? "cache" : null;
  return [modality, tools, cache].filter(Boolean).join(" · ");
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatPrice(value: number): string {
  if (value === 0) return "0";
  if (value < 1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
