import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOpenRouterChatPicks,
  refreshOpenRouterChatCatalogFromApi,
} from "./fetch-openrouter-chat-catalog.js";
import {
  OPENROUTER_CHAT_MODEL_ORDER,
  OPENROUTER_MODELS_CATALOG,
} from "./openrouter-models-catalog.js";

function staticChatIds(): readonly string[] {
  return OPENROUTER_CHAT_MODEL_ORDER.filter(
    (id) => OPENROUTER_MODELS_CATALOG.get(id)?.kind === "chat",
  );
}

/**
 * The picks cache lives at module scope, so a fallback test running after
 * a successful refresh would happily read the previous test's cache and
 * prove nothing. A fresh module instance starts with an empty cache.
 */
async function importFreshModule() {
  vi.resetModules();
  return import("./fetch-openrouter-chat-catalog.js");
}

describe("refreshOpenRouterChatCatalogFromApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Anthropic alongside every other tool-capable model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openrouter/auto",
              name: "Auto",
              context_length: 1_000_000,
              pricing: { prompt: "0", completion: "0" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text", "image"] },
            },
            {
              id: "anthropic/claude-sonnet-4",
              name: "Claude",
              context_length: 200_000,
              pricing: { prompt: "0.000003", completion: "0.000015" },
              supported_parameters: ["tools"],
            },
            {
              id: "qwen/qwen3.6-35b-a3b",
              name: "Qwen 3.6",
              context_length: 262_144,
              pricing: { prompt: "0.00000015", completion: "0.000001" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text"] },
            },
            {
              id: "qwen/qwen3.5-35b-a3b",
              name: "Qwen 3.5",
              context_length: 262_144,
              pricing: { prompt: "0.00000014", completion: "0.000001" },
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text"] },
            },
          ],
        }),
      })),
    );

    const ok = await refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listOpenRouterChatPicks();
    expect(picks.some((p) => p.id === "openrouter/auto")).toBe(true);
    expect(picks.some((p) => p.id === "qwen/qwen3.6-35b-a3b")).toBe(true);
    expect(picks.some((p) => p.id === "qwen/qwen3.5-35b-a3b")).toBe(false);
    // Was `toBe(false)`: `scoreChat` used to return -1 for every
    // `anthropic/*` id, which hid the whole Claude line from the picker.
    // Vendor is a ranking input now, not a gate.
    expect(picks.some((p) => p.id === "anthropic/claude-sonnet-4")).toBe(true);
  });

  it("keeps every advertised model instead of a capped head", async () => {
    // 40 live models: the old MAX_PICKS = 12 cut this to a dozen, hiding
    // most of the catalog from the picker.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(2, "0")}`,
      name: `Model ${i}`,
      context_length: 128_000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"] },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: many }) })),
    );

    const ok = await refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(true);
    const picks = listOpenRouterChatPicks();
    expect(picks.length).toBe(40);
    // Tail models that used to be dropped are now reachable.
    expect(picks.some((p) => p.id === "vendor/model-39")).toBe(true);
  });

  it("shares one in-flight request between concurrent refresh calls", async () => {
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/only",
              context_length: 128_000,
              supported_parameters: ["tools"],
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await importFreshModule();

    const first = mod.refreshOpenRouterChatCatalogFromApi();
    const second = mod.refreshOpenRouterChatCatalogFromApi();
    releaseFetch();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // The TUI kicks the refresh from both the panel prefetch and the
    // wizard picker; those must coalesce into a single network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later, non-overlapping call is a real refresh again.
    await mod.refreshOpenRouterChatCatalogFromApi();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the static catalog when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const mod = await importFreshModule();
    const ok = await mod.refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(false);
    // The exact offline list, not a leftover live cache.
    expect(mod.listOpenRouterChatPicks().map((p) => p.id)).toEqual(
      staticChatIds(),
    );
  });

  it("skips null rows in data instead of losing the whole live catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            null,
            "not-an-object",
            {
              id: "vendor/ok",
              name: "OK",
              context_length: 128_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      })),
    );

    const ok = await refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(true);
    expect(listOpenRouterChatPicks().map((p) => p.id)).toEqual(["vendor/ok"]);
  });

  it("keeps models when supported_parameters is absent", async () => {
    // Mirrors how aimlapi broke: if the provider stops advertising
    // capabilities, silence must not empty the catalog.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/silent",
              name: "Silent",
              context_length: 128_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        }),
      })),
    );

    const ok = await refreshOpenRouterChatCatalogFromApi();
    expect(ok).toBe(true);
    expect(listOpenRouterChatPicks().map((p) => p.id)).toContain("vendor/silent");
  });

  it("still drops models that explicitly lack tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/no-tools",
              name: "No tools",
              context_length: 128_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["temperature"],
            },
            {
              id: "vendor/with-tools",
              name: "With tools",
              context_length: 128_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      })),
    );

    await refreshOpenRouterChatCatalogFromApi();
    const ids = listOpenRouterChatPicks().map((p) => p.id);
    expect(ids).toContain("vendor/with-tools");
    expect(ids).not.toContain("vendor/no-tools");
  });
});
