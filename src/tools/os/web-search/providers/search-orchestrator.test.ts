import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../../config/index.js";
import { runWebSearchWithFallback } from "./search-orchestrator.js";
import { createSearchCache } from "../transport/search-cache.js";
import { WebSearchBlockedError } from "../web-search-errors.js";
import type {
  WebSearchProviderName,
  WebSearchProviderOptions,
  WebSearchResult,
} from "../web-search-provider.js";

const RESULT: WebSearchResult = {
  title: "T",
  url: "https://t.example",
  snippet: "s",
};

function makeConfig(
  overrides: Partial<AtomicAgentConfig["web"]["search"]> = {},
): Pick<AtomicAgentConfig, "web"> {
  return {
    web: {
      search: {
        enabled: true,
        provider: "duckduckgo",
        maxResults: 8,
        timeoutMs: 15_000,
        cacheTtlMinutes: 15,
        fallback: [],
        searxng: { instanceUrl: null },
        exa: {
          endpoint: "https://mcp.exa.ai/mcp",
          apiEndpoint: "https://api.exa.ai/search",
          apiKeyEnv: "EXA_API_KEY",
        },
        brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
        ...overrides,
      },
    },
  };
}

function makeOptions(): WebSearchProviderOptions {
  return {
    query: "q",
    maxResults: 5,
    timeoutMs: 1000,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };
}

/**
 * Patches `resolveProviderByName` indirectly by stubbing each provider's HTTP
 * deps is heavy; instead we inject behaviour by mocking the registry module.
 */
vi.mock("./provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-registry.js")>();
  return {
    ...actual,
    resolveProviderByName: vi.fn(),
  };
});

import { resolveProviderByName } from "./provider-registry.js";

function stubProvider(
  name: WebSearchProviderName,
  impl: () => Promise<WebSearchResult[]>,
) {
  return { name, search: vi.fn(impl) };
}

describe("runWebSearchWithFallback", () => {
  it("returns primary provider results on success", async () => {
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockReturnValue(ddg);

    const out = await runWebSearchWithFallback({
      config: makeConfig(),
      deps: {},
      options: makeOptions(),
    });

    expect(out.provider).toBe("duckduckgo");
    expect(out.results).toEqual([RESULT]);
    expect(out.fromCache).toBe(false);
  });

  it("skips unusable providers (searxng without instanceUrl, brave without key)", async () => {
    const exa = stubProvider("exa", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) => {
      if (name === "exa") return exa;
      throw new Error(`unexpected provider ${name}`);
    });

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "searxng", fallback: ["brave", "exa"] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("exa");
    expect(exa.search).toHaveBeenCalledOnce();
  });

  it("advances on WebSearchBlockedError then succeeds on the fallback", async () => {
    const ddg = stubProvider("duckduckgo", async () => {
      throw new WebSearchBlockedError("duckduckgo");
    });
    const exa = stubProvider("exa", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "duckduckgo" ? ddg : exa,
    );

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "duckduckgo", fallback: ["exa"] }),
      deps: {},
      options: makeOptions(),
    });

    expect(out.provider).toBe("exa");
    expect(out.results).toEqual([RESULT]);
  });

  it("advances on empty results, returning the last empty when all are empty", async () => {
    const ddg = stubProvider("duckduckgo", async () => []);
    const exa = stubProvider("exa", async () => []);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "duckduckgo" ? ddg : exa,
    );

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "duckduckgo", fallback: ["exa"] }),
      deps: {},
      options: makeOptions(),
    });

    expect(out.results).toEqual([]);
    expect(out.provider).toBe("exa");
    expect(exa.search).toHaveBeenCalledOnce();
  });

  it("rethrows the first error when every provider throws", async () => {
    const ddg = stubProvider("duckduckgo", async () => {
      throw new WebSearchBlockedError("duckduckgo", "ddg blocked");
    });
    const exa = stubProvider("exa", async () => {
      throw new Error("exa transport");
    });
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "duckduckgo" ? ddg : exa,
    );

    await expect(
      runWebSearchWithFallback({
        config: makeConfig({ provider: "duckduckgo", fallback: ["exa"] }),
        deps: {},
        options: makeOptions(),
      }),
    ).rejects.toThrow("ddg blocked");
  });

  it("caches successful results and serves a hit without calling the provider again", async () => {
    const cache = createSearchCache({ ttlMs: 60_000, now: () => 0 });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockReturnValue(ddg);

    const first = await runWebSearchWithFallback({
      config: makeConfig(),
      deps: {},
      options: makeOptions(),
      cache,
    });
    expect(first.fromCache).toBe(false);

    const second = await runWebSearchWithFallback({
      config: makeConfig(),
      deps: {},
      options: makeOptions(),
      cache,
    });
    expect(second.fromCache).toBe(true);
    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("throws a blocked error when no provider is usable and nothing is cached", async () => {
    vi.mocked(resolveProviderByName).mockImplementation(() => {
      throw new Error("should not resolve");
    });

    await expect(
      runWebSearchWithFallback({
        config: makeConfig({ provider: "searxng", fallback: ["brave"] }),
        deps: {},
        options: makeOptions(),
        env: {},
      }),
    ).rejects.toBeInstanceOf(WebSearchBlockedError);
  });
});
