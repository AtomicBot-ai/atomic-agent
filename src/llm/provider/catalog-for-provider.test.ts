import { describe, expect, it } from "vitest";
import { catalogForProvider, modelsDevEntryForProvider } from "./catalog-for-provider.js";
import { resolveModel } from "./model-resolver.js";
import type { LlmProviderConfigEntry } from "./registry/provider-types.js";

const entry = (
  kind: string,
  extra: Partial<LlmProviderConfigEntry> = {},
): LlmProviderConfigEntry => ({ id: kind, kind, ...extra });

describe("catalogForProvider", () => {
  it("returns a populated catalog for the aggregators", () => {
    expect(catalogForProvider(entry("openrouter")).size).toBeGreaterThan(0);
    expect(catalogForProvider(entry("aimlapi")).size).toBeGreaterThan(0);
  });

  it("returns an empty catalog for providers that ship none", () => {
    for (const kind of ["llama-server", "openai-compatible", "gemini"]) {
      expect(catalogForProvider(entry(kind)).size).toBe(0);
    }
  });

  it("returns an empty catalog for an unknown kind", () => {
    expect(catalogForProvider(entry("some-future-provider")).size).toBe(0);
  });
});

describe("resolveModel with a provider catalog", () => {
  const openrouter = entry("openrouter");
  const [catalogId] = [...catalogForProvider(openrouter).keys()];

  it("prices a catalog model that carries no userModels entry", () => {
    const resolved = resolveModel(
      openrouter,
      catalogId,
      catalogForProvider(openrouter),
    );

    expect(resolved.source).toBe("catalog");
    expect(resolved.pricing).toBeDefined();
  });

  it("reports no pricing for the same model without the catalog", () => {
    // The pre-fix call shape: `resolveModel` defaults to an empty map, so
    // an unpriced cloud model fell through to DEFAULT_CHAT and `cost_usd`
    // was never emitted.
    const resolved = resolveModel(openrouter, catalogId);

    expect(resolved.source).not.toBe("catalog");
    expect(resolved.pricing).toBeUndefined();
  });

  it("keeps hand-configured pricing ahead of the catalog", () => {
    const priced = entry("openrouter", {
      userModels: [
        {
          id: catalogId,
          kind: "chat",
          pricing: { input: 1.25, output: 4.5 },
        },
      ],
    });

    const resolved = resolveModel(
      priced,
      catalogId,
      catalogForProvider(priced),
    );

    expect(resolved.source).toBe("user");
    expect(resolved.pricing).toEqual({ input: 1.25, output: 4.5 });
  });

  it("leaves local runners unpriced", () => {
    const local = entry("llama-server");
    const resolved = resolveModel(
      local,
      "some-local.gguf",
      catalogForProvider(local),
    );

    expect(resolved.pricing).toBeUndefined();
  });
});

// ATO-647: models.dev is a separate, per-model source; it does not
// widen the bundled catalog that vision and strict-tool checks read.
describe("modelsDevEntryForProvider", () => {
  const moonshot = entry("openai-compatible", { id: "moonshot", baseUrl: "https://api.moonshot.ai" });

  it("answers for a preset the bundled catalogs do not cover", () => {
    expect(catalogForProvider(moonshot).size).toBe(0);
    expect(modelsDevEntryForProvider(moonshot, "kimi-k3.1-pro")?.pricing?.input).toBe(2);
  });

  it("has nothing for the aggregators, which carry their own catalog", () => {
    expect(modelsDevEntryForProvider(entry("openrouter"), "moonshotai/kimi-k3.1-pro")).toBeUndefined();
  });
});
