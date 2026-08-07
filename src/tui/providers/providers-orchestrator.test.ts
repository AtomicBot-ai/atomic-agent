import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";

/**
 * The catalog caches live at module scope inside the fetch modules, so
 * every test builds the orchestrator from a fresh module registry: a
 * warm cache inherited from a previous test would silently skip the
 * network path under test.
 */
async function importFreshOrchestrator() {
  vi.resetModules();
  return import("./providers-orchestrator.js");
}

function fakeBus() {
  return {
    subscribe: vi.fn(() => () => {}),
    emit: vi.fn(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function stubCatalogFetch() {
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes("openrouter")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/live-or",
              context_length: 128_000,
              supported_parameters: ["tools"],
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "vendor/live-aiml", type: "chat-completion" }],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ProvidersOrchestrator.prefetchCloudCatalogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches both catalogs when cold and reports via providers_status", async () => {
    const fetchMock = stubCatalogFetch();
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();

    const urls = fetchMock.mock.calls.map((call) => String(call[0])).sort();
    expect(urls).toEqual([
      "https://api.aimlapi.com/v1/models",
      "https://openrouter.ai/api/v1/models",
    ]);
    // The status emits are what re-render already-mounted panels so
    // they re-read the now-live module cache.
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_status",
      line: "OpenRouter model list updated from API",
    });
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_status",
      line: "AI/ML API model list updated from API",
    });
  });

  it("skips the network entirely while the caches are warm", async () => {
    const fetchMock = stubCatalogFetch();
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Wired to tab activation, this runs on every providers/LLM tab
    // visit; within the cache TTL it must stay free.
    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the static fallback intact when both fetches fail", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();

    // No success status lines and no crash; the pickers keep serving
    // the static catalog.
    expect(bus.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "providers_status" }),
    );

    // A cold cache means the next visit retries instead of latching
    // onto the failure.
    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
