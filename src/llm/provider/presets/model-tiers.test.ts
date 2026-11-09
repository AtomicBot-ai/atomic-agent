import { describe, expect, it } from "vitest";

import { AIMLAPI_MODELS_CATALOG } from "../aimlapi/aimlapi-models-catalog.js";
import { OPENROUTER_MODELS_CATALOG } from "../openrouter/openrouter-models-catalog.js";
import { CLAUDE_CLI_CHAT_MODELS } from "../subscription-cli/claude-cli-models.js";
import { MODEL_TIERS, MODEL_TIER_ORDER, modelTierKey, modelTierOf } from "./model-tiers.js";

/** Every tier must name a model the provider's bundled catalog knows. */
const KNOWN: Record<string, (id: string) => boolean> = {
  openrouter: (id) => OPENROUTER_MODELS_CATALOG.get(id)?.kind === "chat",
  aimlapi: (id) => AIMLAPI_MODELS_CATALOG.get(id)?.kind === "chat",
  // Gemini has no bundled catalog; its ids are OpenRouter's without the vendor prefix.
  gemini: (id) => OPENROUTER_MODELS_CATALOG.get(`google/${id}`)?.kind === "chat",
  "claude-cli": (id) => CLAUDE_CLI_CHAT_MODELS.includes(id),
};

describe("MODEL_TIERS (ATO-32)", () => {
  it.each(Object.entries(MODEL_TIERS))("%s: every tier is a known chat model, all three distinct", (key, tiers) => {
    const known = KNOWN[key];
    expect(known, `no catalog check for ${key}`).toBeDefined();
    for (const tier of MODEL_TIER_ORDER) expect(known!(tiers[tier]), `${key}.${tier}=${tiers[tier]}`).toBe(true);
    expect(new Set(MODEL_TIER_ORDER.map((t) => tiers[t])).size).toBe(3);
  });

  it("orders openrouter tiers by price: cheap < balanced < best", () => {
    const price = (id: string) => {
      const e = OPENROUTER_MODELS_CATALOG.get(id);
      return e?.kind === "chat" ? (e.pricing?.input ?? 0) + (e.pricing?.output ?? 0) : NaN;
    };
    const t = MODEL_TIERS.openrouter!;
    expect(price(t.cheap)).toBeLessThan(price(t.balanced));
    expect(price(t.balanced)).toBeLessThan(price(t.best));
  });

  it("keys a subscription entry by its CLI and finds a model's tier", () => {
    expect(modelTierKey("subscription-cli", "claude")).toBe("claude-cli");
    expect(modelTierKey("openrouter")).toBe("openrouter");
    expect(modelTierOf("claude-cli", "sonnet")).toBe("balanced");
    expect(modelTierOf("openrouter", "vendor/unknown")).toBeNull();
    expect(modelTierOf("codex-cli", "anything")).toBeNull();
  });
});
