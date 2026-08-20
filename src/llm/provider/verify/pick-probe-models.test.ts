import { afterEach, describe, expect, it, vi } from "vitest";

async function importFresh(): Promise<
  typeof import("./pick-probe-models.js")
> {
  // The OpenRouter catalog caches at module scope, so a test that primes
  // it would otherwise leak into the next one.
  vi.resetModules();
  return import("./pick-probe-models.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickProbeModels", () => {
  it("never probes OpenRouter with a free model", async () => {
    // A zero-cost model answers 200 on a key with no credit at all,
    // which is exactly the case the check exists to catch.
    const { pickProbeModels, cheapestPaidOpenRouterModel } = await importFresh();
    const cheapest = cheapestPaidOpenRouterModel();
    expect(cheapest).not.toBeNull();
    expect(cheapest).not.toBe("openrouter/auto");
    expect(cheapest).not.toContain(":free");

    const picks = pickProbeModels({ kind: "openrouter" });
    expect(picks[0]).toBe(cheapest);
  });

  it("keeps the free rows of a live catalog out of the choice", async () => {
    const { refreshOpenRouterChatCatalogFromApi } = await import(
      "../openrouter/fetch-openrouter-chat-catalog.js"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/free-model:free",
              name: "Free",
              context_length: 128_000,
              pricing: { prompt: "0", completion: "0" },
              supported_parameters: ["tools"],
            },
            {
              id: "vendor/cheap-model",
              name: "Cheap",
              context_length: 128_000,
              pricing: { prompt: "0.0000001", completion: "0.0000002" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      })),
    );
    await refreshOpenRouterChatCatalogFromApi();

    const { cheapestPaidOpenRouterModel } = await import(
      "./pick-probe-models.js"
    );
    expect(cheapestPaidOpenRouterModel()).toBe("vendor/cheap-model");
  });

  it("adds the operator's own pick as the fallback candidate", async () => {
    const { pickProbeModels, cheapestPaidOpenRouterModel } = await importFresh();
    const picks = pickProbeModels({
      kind: "openrouter",
      selectedModelId: "vendor/picked",
    });
    expect(picks).toEqual([cheapestPaidOpenRouterModel(), "vendor/picked"]);
  });

  it("probes the chosen model where the catalog has no prices", async () => {
    const { pickProbeModels } = await importFresh();
    const { AIMLAPI_DEFAULT_CHAT_MODEL } = await import(
      "../aimlapi/aimlapi-models-catalog.js"
    );
    const { GEMINI_DEFAULT_CHAT_MODEL } = await import(
      "../gemini/gemini-provider.js"
    );

    expect(
      pickProbeModels({ kind: "aimlapi", selectedModelId: "openai/gpt-5-nano" }),
    ).toEqual(["openai/gpt-5-nano", AIMLAPI_DEFAULT_CHAT_MODEL]);
    expect(pickProbeModels({ kind: "gemini" })).toEqual([
      GEMINI_DEFAULT_CHAT_MODEL,
    ]);
  });

  it("uses the discovered list for an arbitrary compatible endpoint", async () => {
    const { pickProbeModels } = await importFresh();
    expect(
      pickProbeModels({
        kind: "openai-compatible",
        selectedModelId: "  ",
        listedModelIds: ["local-a", "local-b"],
      }),
    ).toEqual(["local-a"]);
    expect(
      pickProbeModels({
        kind: "openai-compatible",
        selectedModelId: "typed-id",
        listedModelIds: ["local-a"],
      }),
    ).toEqual(["typed-id", "local-a"]);
  });
});
