import { afterEach, describe, it, expect, vi } from "vitest";
import { refreshOpenRouterChatCatalogFromApi } from "../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";

/**
 * Pricing follows the provider that SERVED the tokens. In fusion mode
 * the active provider is the cloud orchestrator while the workers spend
 * on the local leg; pricing worker tokens against the active entry would
 * invent a cloud cost for local inference.
 */
describe("resolveModelPricingFor", () => {
  const resolved: ResolvedLlmConfig = {
    activeTextProvider: "cloud",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [
      {
        id: "cloud",
        kind: "openai",
        defaultChatModel: "shared-model",
        userModels: [
          {
            id: "shared-model",
            kind: "chat",
            pricing: { input: 3, output: 15 },
          },
        ],
      },
      {
        id: "local-llama",
        kind: "llama-server",
        url: "http://127.0.0.1:8080",
        userModels: [
          {
            id: "shared-model",
            kind: "chat",
            pricing: { input: 0, output: 0 },
          },
        ],
      },
      { id: "unpriced", kind: "llama-server", url: "http://127.0.0.1:8081" },
    ],
  };

  it("defaults to the active provider", () => {
    expect(resolveModelPricingFor(resolved, "shared-model")?.pricing).toEqual({
      input: 3,
      output: 15,
    });
  });

  it("prices against the served provider when one is named", () => {
    expect(
      resolveModelPricingFor(resolved, "shared-model", "local-llama")?.pricing,
    ).toEqual({ input: 0, output: 0 });
  });

  it("a served provider with no pricing yields no pricing, not the active one's", () => {
    expect(
      resolveModelPricingFor(resolved, "shared-model", "unpriced")?.pricing,
    ).toBeUndefined();
  });

  it("an unknown provider id or a null model id resolves to nothing", () => {
    expect(
      resolveModelPricingFor(resolved, "shared-model", "ghost"),
    ).toBeUndefined();
    expect(resolveModelPricingFor(resolved, null, "cloud")).toBeUndefined();
  });
});

describe("resolveModelPricingFor — OpenRouter live catalog (F30)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const resolved: ResolvedLlmConfig = {
    activeTextProvider: "or",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [{ id: "or", kind: "openrouter", defaultChatModel: "acme/new-model" }],
  };

  it("takes context_length from the live list for a model neither configured nor bundled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "acme/new-model",
              name: "New",
              context_length: 65_536,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      })),
    );
    expect(await refreshOpenRouterChatCatalogFromApi()).toBe(true);
    const model = resolveModelPricingFor(resolved, "acme/new-model");
    expect(model?.source).toBe("live");
    expect(model?.contextWindow).toBe(65_536);
    expect(model?.pricing).toEqual({ input: 1, output: 2 });
    // Still unknown: not in the live list either.
    expect(resolveModelPricingFor(resolved, "acme/other")?.source).toBe("default");
  });
});

// ATO-647: the bundled models.dev snapshot prices the direct presets
// that have no catalog of their own.
describe("resolveModelPricingFor — models.dev snapshot", () => {
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
      { id: "proxy", kind: "openai-compatible", baseUrl: "https://llm.example.com/v1" },
    ],
  };

  it("prices a preset model nobody priced by hand", () => {
    const model = resolveModelPricingFor(resolved, "kimi-k3.1-pro");
    expect(model?.source).toBe("catalog");
    expect(model?.pricing).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 });
    expect(model?.contextWindow).toBe(1_048_576);
  });

  it("a hand-entered price beats models.dev", () => {
    const model = resolveModelPricingFor(resolved, "kimi-k3.1-pro", "moonshot-2");
    expect(model?.source).toBe("user");
    expect(model?.pricing).toEqual({ input: 1, output: 5 });
  });

  it("an endpoint models.dev does not cover stays unpriced", () => {
    const model = resolveModelPricingFor(resolved, "kimi-k3.1-pro", "proxy");
    expect(model?.source).toBe("default");
    expect(model?.pricing).toBeUndefined();
  });
});
