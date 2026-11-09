/**
 * Cheap, balanced and best chat models per provider kind (ATO-32): the
 * short list a model picker shows first, as "Cheap" / "Balanced" /
 * "Best", so a person who does not know model names still gets a good
 * pick. The one place this list lives; the TUI pickers read it here and
 * the desktop reads it through `GET /api/model-tiers`.
 *
 * Rules for a row:
 *  - The id must be in the kind's bundled catalog (`model-tiers.test.ts`
 *    checks it), so a tier never points at a model the picker cannot
 *    describe or the provider does not serve.
 *  - Cheap: lowest price that still calls tools reliably. Balanced: the
 *    pick for everyday work. Best: the strongest model, price aside.
 *  - Leave a kind out rather than guess. Codex is out on purpose: under
 *    a ChatGPT login it rejects every explicit model and picks its own.
 *
 * Re-checked against the bundled catalogs 2026-10-28.
 */
export type ModelTier = "cheap" | "balanced" | "best";

export const MODEL_TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  cheap: "Cheap",
  balanced: "Balanced",
  best: "Best",
};

export const MODEL_TIER_ORDER: readonly ModelTier[] = ["cheap", "balanced", "best"];

export const MODEL_TIERS: Readonly<Record<string, Readonly<Record<ModelTier, string>>>> = {
  openrouter: {
    cheap: "deepseek/deepseek-v4-flash",
    balanced: "google/gemini-3.7-flash",
    best: "anthropic/claude-sonnet-5",
  },
  aimlapi: {
    cheap: "openai/gpt-5-mini-2025-08-07",
    balanced: "google/gemini-3.7-flash",
    best: "anthropic/claude-sonnet-5",
  },
  gemini: {
    cheap: "gemini-3.5-flash-lite",
    balanced: "gemini-3.7-flash",
    best: "gemini-3.1-pro-preview",
  },
  "claude-cli": {
    cheap: "haiku",
    balanced: "sonnet",
    best: "opus",
  },
};

/**
 * The tier keys a provider entry uses: a subscription-CLI entry is keyed
 * by its CLI (`claude-cli`), every other entry by its kind.
 */
export function modelTierKey(kind: string, subscriptionCli?: string): string {
  return kind === "subscription-cli" && subscriptionCli ? `${subscriptionCli}-cli` : kind;
}

/** The tier a model holds for a provider, or null when it holds none. */
export function modelTierOf(key: string, modelId: string): ModelTier | null {
  const tiers = MODEL_TIERS[key];
  if (!tiers) return null;
  return MODEL_TIER_ORDER.find((t) => tiers[t] === modelId) ?? null;
}
