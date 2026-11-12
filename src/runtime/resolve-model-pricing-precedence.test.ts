import { describe, expect, it, vi } from "vitest";

import type { ModelCatalogEntry } from "../llm/provider/model-resolver.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";

// No provider ships both a bundled catalog and a models.dev mapping
// today, so the bundled catalog is stubbed for Moonshot to pin the order
// (ATO-647): userModels > bundled catalog > models.dev.
vi.mock("../llm/provider/catalog-for-provider.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../llm/provider/catalog-for-provider.js")>();
  const row: ModelCatalogEntry = {
    id: "kimi-k3.1-pro",
    kind: "chat",
    contextWindow: 200_000,
    supportsVision: true,
    supportsTools: "parallel",
    supportsPromptCache: false,
    reasoningFormat: "none",
    pricing: { input: 7, output: 7 },
  };
  return {
    ...original,
    catalogForProvider: () => new Map([["kimi-k3.1-pro", row]]),
  };
});

describe("resolveModelPricingFor — source precedence", () => {
  const resolved: ResolvedLlmConfig = {
    activeTextProvider: "moonshot",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [
      { id: "moonshot", kind: "openai-compatible", baseUrl: "https://api.moonshot.ai" },
      {
        id: "moonshot-2",
        kind: "openai-compatible",
        baseUrl: "https://api.moonshot.ai",
        userModels: [{ id: "kimi-k3.1-pro", kind: "chat", pricing: { input: 1, output: 5 } }],
      },
    ],
  };

  it("the bundled catalog beats models.dev", () => {
    const model = resolveModelPricingFor(resolved, "kimi-k3.1-pro");
    expect(model?.pricing).toEqual({ input: 7, output: 7 });
    expect(model?.contextWindow).toBe(200_000);
  });

  it("a hand-entered price beats both", () => {
    expect(resolveModelPricingFor(resolved, "kimi-k3.1-pro", "moonshot-2")?.pricing).toEqual({
      input: 1,
      output: 5,
    });
  });

  it("models.dev still answers for a model the catalog lacks", () => {
    expect(resolveModelPricingFor(resolved, "kimi-k3")?.pricing?.input).toBeGreaterThan(0);
  });
});
