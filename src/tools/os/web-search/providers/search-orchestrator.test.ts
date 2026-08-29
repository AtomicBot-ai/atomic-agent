import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../../config/index.js";
import { runWebSearchWithFallback } from "./search-orchestrator.js";
import { createProviderCooldown } from "../transport/provider-cooldown.js";
import { createSearchCache } from "../transport/search-cache.js";
import {
  WebSearchBlockedError,
  WebSearchRateLimitedError,
} from "../web-search-errors.js";
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

/**
 * Issue #179, reproduced at the level it actually bites.
 *
 * The transport already retries a 429 twice against the same provider,
 * which is right for a burst. What the campaign measured was not a
 * burst: 1341 429s spread evenly across 24 hours, 8-20 an hour, not
 * tracking concurrency. Against a standing quota, every search paid for
 * three doomed requests and ~1.5s of backoff before reaching the
 * provider that was always going to answer it — and the answer, coming
 * from the weaker fallback, looked exactly like a normal one.
 */
describe("a provider under a standing rate limit", () => {
  const T0 = 5_000_000;

  function limitedThenFallback() {
    const exa = stubProvider("exa", async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    return { exa, ddg };
  }

  it("stops asking it, instead of asking it again on every query", async () => {
    const { exa, ddg } = limitedThenFallback();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    let clock = T0;

    const first = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      cooldown,
      now: () => clock,
    });
    expect(first.provider).toBe("duckduckgo");
    expect(exa.search).toHaveBeenCalledOnce();

    // Ten more searches inside the park. Before this, each one re-entered
    // the retry ladder against a provider that could not answer.
    clock = T0 + 30_000;
    for (let i = 0; i < 10; i++) {
      const out = await runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query: `q${i}` },
        cooldown,
        now: () => clock,
      });
      expect(out.provider).toBe("duckduckgo");
    }
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).toHaveBeenCalledTimes(11);
  });

  it("tries it again once the park expires", async () => {
    const { exa } = limitedThenFallback();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    let clock = T0;

    await runWebSearchWithFallback({
      config, deps: {}, options: makeOptions(), cooldown, now: () => clock,
    });
    clock = T0 + 61_000;
    await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "later" },
      cooldown,
      now: () => clock,
    });
    expect(exa.search).toHaveBeenCalledTimes(2);
  });

  it("says out loud that the answer came from the fallback", async () => {
    // The other half of #179: the chain worked, so nothing failed, so
    // nothing was reported — and a whole campaign was quietly served by
    // the weaker provider.
    const { } = limitedThenFallback();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });

    const first = await runWebSearchWithFallback({
      config, deps: {}, options: makeOptions(), cooldown, now: () => T0,
    });
    expect(first.degraded).toEqual([
      "exa rate limited (HTTP 429), parked for 1m",
    ]);

    const second = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "next" },
      cooldown,
      now: () => T0 + 20_000,
    });
    expect(second.degraded).toEqual([
      "exa skipped: rate limited, retrying in 40s",
    ]);
  });

  it("still serves a parked provider's cached results", async () => {
    // The park is about quota, not staleness. An answer already in hand
    // is not worse because the provider that gave it has since run out.
    const exa = stubProvider("exa", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockReturnValue(exa);
    const cooldown = createProviderCooldown();
    const cache = createSearchCache({ ttlMs: 60_000 });
    const config = makeConfig({ provider: "exa", fallback: [] });

    await runWebSearchWithFallback({
      config, deps: {}, options: makeOptions(), cache, cooldown, now: () => T0,
    });
    cooldown.park("exa", T0, null);

    const out = await runWebSearchWithFallback({
      config, deps: {}, options: makeOptions(), cache, cooldown, now: () => T0,
    });
    expect(out.fromCache).toBe(true);
    expect(out.results).toEqual([RESULT]);
    expect(exa.search).toHaveBeenCalledOnce();
  });

  it("does not park a provider that failed for some other reason", async () => {
    // A blocked page or a dead endpoint should be retried on the next
    // query; only a quota earns silence.
    const exa = stubProvider("exa", async () => {
      throw new WebSearchBlockedError("exa");
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });

    for (let i = 0; i < 3; i++) {
      const out = await runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query: `q${i}` },
        cooldown,
        now: () => T0,
      });
      expect(out.degraded).toEqual([]);
    }
    expect(exa.search).toHaveBeenCalledTimes(3);
  });

  it("behaves exactly as before when no cooldown is supplied", async () => {
    const { exa } = limitedThenFallback();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    for (let i = 0; i < 3; i++) {
      await runWebSearchWithFallback({
        config, deps: {}, options: { ...makeOptions(), query: `q${i}` },
      });
    }
    expect(exa.search).toHaveBeenCalledTimes(3);
  });
});
