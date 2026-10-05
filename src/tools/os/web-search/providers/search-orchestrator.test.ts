import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../../config/index.js";
import { runWebSearchWithFallback } from "./search-orchestrator.js";
import { createProviderCooldown } from "../transport/provider-cooldown.js";
import { createSearchCache } from "../transport/search-cache.js";
import {
  WebSearchBlockedError,
  WebSearchRateLimitedError,
  WebSearchUnavailableError,
} from "../web-search-errors.js";
import type {
  WebSearchProviderName,
  WebSearchProviderOptions,
  WebSearchProviderOutcome,
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
        anysearch: {
          endpoint: "https://api.anysearch.com/v1/search",
          apiKeyEnv: "ANYSEARCH_API_KEY",
          zone: null,
          language: null,
        },
        ...overrides,
      },
    },
  };
}

/** An env with an Exa key, so the chain actually asks Exa (ATO-120). */
const EXA_KEYED: NodeJS.ProcessEnv = { EXA_API_KEY: "k" };

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
  const actual =
    await importOriginal<typeof import("./provider-registry.js")>();
  return {
    ...actual,
    resolveProviderByName: vi.fn(),
  };
});

import { resolveProviderByName } from "./provider-registry.js";

function stubProvider(
  name: WebSearchProviderName,
  impl: () => Promise<WebSearchResult[] | WebSearchProviderOutcome>,
) {
  return {
    name,
    search: vi.fn(async () => {
      const out = await impl();
      return Array.isArray(out) ? { results: out } : out;
    }),
  };
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
      env: EXA_KEYED,
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
      env: EXA_KEYED,
    });

    expect(out.provider).toBe("exa");
    expect(out.results).toEqual([RESULT]);
    // The search succeeded; the blocked attempt is a note, not the error.
    expect(out.degraded).toEqual([
      "duckduckgo failed: duckduckgo rate-limited or returned a bot challenge",
    ]);
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
      env: EXA_KEYED,
    });

    expect(out.results).toEqual([]);
    expect(out.provider).toBe("exa");
    expect(exa.search).toHaveBeenCalledOnce();
  });

  it("reports every provider in one error when all of them throw (ATO-325)", async () => {
    const ddg = stubProvider("duckduckgo", async () => {
      throw new WebSearchBlockedError("duckduckgo", "ddg blocked");
    });
    const exa = stubProvider("exa", async () => {
      throw new Error("exa transport");
    });
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "duckduckgo" ? ddg : exa,
    );

    const err = (await runWebSearchWithFallback({
      config: makeConfig({ provider: "duckduckgo", fallback: ["exa"] }),
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.provider).toBe("duckduckgo");
    expect(err.failures).toEqual([
      "duckduckgo: ddg blocked",
      "exa: exa transport",
    ]);
    expect(err.message).toContain("- duckduckgo: ddg blocked");
    expect(err.message).toContain("- exa: exa transport");
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
 * provider that was always going to answer it ?and the answer, coming
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
      env: EXA_KEYED,
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
        env: EXA_KEYED,
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
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cooldown,
      now: () => clock,
    });
    clock = T0 + 61_000;
    await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "later" },
      env: EXA_KEYED,
      cooldown,
      now: () => clock,
    });
    expect(exa.search).toHaveBeenCalledTimes(2);
  });

  it("says out loud that the answer came from the fallback", async () => {
    // The other half of #179: the chain worked, so nothing failed, so
    // nothing was reported ?and a whole campaign was quietly served by
    // the weaker provider.
    const {} = limitedThenFallback();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });

    const first = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cooldown,
      now: () => T0,
    });
    expect(first.degraded).toEqual([
      "exa rate limited (HTTP 429), parked for 1m",
    ]);

    const second = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "next" },
      env: EXA_KEYED,
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
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cache,
      cooldown,
      now: () => T0,
    });
    cooldown.park("exa", T0, null);

    const out = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cache,
      cooldown,
      now: () => T0,
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
        env: EXA_KEYED,
        cooldown,
        now: () => T0,
      });
      // Reported as a failure each time, never as "skipped": it was
      // asked again on every query.
      expect(out.degraded).toEqual([
        "exa failed: exa rate-limited or returned a bot challenge",
      ]);
    }
    expect(exa.search).toHaveBeenCalledTimes(3);
  });

  it("behaves exactly as before when no cooldown is supplied", async () => {
    const { exa } = limitedThenFallback();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    for (let i = 0; i < 3; i++) {
      await runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query: `q${i}` },
        env: EXA_KEYED,
      });
    }
    expect(exa.search).toHaveBeenCalledTimes(3);
  });
});

/**
 * ATO-327. ATO-120 skipped Exa without a key, which left DuckDuckGo as
 * the only keyless provider; where DuckDuckGo is blocked, search did not
 * work at all (ATO-315). Keyless Exa is back in the chain, first when it
 * is the primary, with DuckDuckGo behind it; its free tier runs out fast,
 * so a 429 parks it and the result asks for a key.
 */
describe("an Exa primary without a key", () => {
  function exaAndDdg() {
    const exa = stubProvider("exa", async () => {
      throw new Error("Exa returned HTTP 403");
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    const searxng = stubProvider("searxng", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) => {
      if (name === "exa") return exa;
      if (name === "duckduckgo") return ddg;
      if (name === "searxng") return searxng;
      throw new Error(`unexpected provider ${name}`);
    });
    return { exa, ddg, searxng };
  }

  const KEY_REQUIRED_RATE_LIMITED = {
    provider: "exa",
    reason: "rate_limited",
    getKeyUrl: "https://dashboard.exa.ai/api-keys",
    envVar: "EXA_API_KEY",
  };

  const CONNECT_TIMEOUT =
    "curl: (28) Connection timed out after 5002 milliseconds";

  it("answers from keyless Exa when its free tier works", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => ({ results: [RESULT] }));

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("exa");
    expect(out.degraded).toEqual([]);
    expect(out.keyRequired).toBeUndefined();
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).not.toHaveBeenCalled();
  });

  it("asks keyless Exa first, then DuckDuckGo", async () => {
    const { exa, ddg } = exaAndDdg();

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("duckduckgo");
    expect(out.results).toEqual([RESULT]);
    expect(exa.search).toHaveBeenCalledOnce();
    expect(exa.search.mock.invocationCallOrder[0]!).toBeLessThan(
      ddg.search.mock.invocationCallOrder[0]!,
    );
    expect(out.degraded).toEqual(["exa failed: Exa returned HTTP 403"]);
    // Only a free-limit hit asks for a key while the search succeeded.
    expect(out.keyRequired).toBeUndefined();
  });

  it("treats a whitespace-only key as no key: Exa runs keyless", async () => {
    const { exa } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: { EXA_API_KEY: "   " },
    });

    expect(out.provider).toBe("duckduckgo");
    expect(out.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
  });

  it("still has DuckDuckGo behind keyless Exa when no fallback is configured", async () => {
    const { exa, ddg } = exaAndDdg();

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: [] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("duckduckgo");
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("keeps the configured fallback order, with DuckDuckGo appended last", async () => {
    const { exa, searxng, ddg } = exaAndDdg();
    searxng.search.mockImplementation(async () => {
      throw new WebSearchBlockedError("searxng", "searxng blocked");
    });

    const out = await runWebSearchWithFallback({
      config: makeConfig({
        provider: "exa",
        fallback: ["searxng"],
        searxng: { instanceUrl: "https://searx.example" },
      }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    const order = [exa, searxng, ddg].map(
      (stub) => stub.search.mock.invocationCallOrder[0]!,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out.provider).toBe("duckduckgo");
    expect(out.degraded).toEqual([
      "exa failed: Exa returned HTTP 403",
      "searxng failed: searxng blocked",
    ]);
  });

  it("parks keyless Exa on its free limit and asks for a key", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    const T0 = 5_000_000;

    const first = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0,
    });
    expect(first.provider).toBe("duckduckgo");
    expect(first.degraded).toEqual([
      "exa free limit reached (HTTP 429, no EXA_API_KEY), parked for 1m",
    ]);
    expect(first.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);

    // Inside the park Exa is not asked again, and the ask for a key stays.
    const second = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "next" },
      env: {},
      cooldown,
      now: () => T0 + 20_000,
    });
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).toHaveBeenCalledTimes(2);
    expect(second.degraded).toEqual([
      "exa skipped: free limit reached, retrying in 40s",
    ]);
    expect(second.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
  });

  it("reports every provider and the key link in one error when all fail", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    ddg.search.mockImplementation(async () => {
      throw new Error(CONNECT_TIMEOUT);
    });

    const err = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown: createProviderCooldown(),
      now: () => 5_000_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    // Still a blocked error to anything that matches on that.
    expect(err).toBeInstanceOf(WebSearchBlockedError);
    const unavailable = err as WebSearchUnavailableError;
    expect(unavailable.failures).toEqual([
      "exa: free limit reached (HTTP 429)",
      `duckduckgo: could not connect, the connection timed out after 5 s (site unreachable from this network); ${CONNECT_TIMEOUT}`,
    ]);
    expect(unavailable.message).toContain("exa: free limit reached");
    expect(unavailable.message).toContain(
      "duckduckgo: could not connect, the connection timed out after 5 s",
    );
    expect(unavailable.message).toContain("https://dashboard.exa.ai/api-keys");
    expect(unavailable.message).toContain("EXA_API_KEY=...");
    expect(unavailable.message).toContain("Do not repeat this search");
    expect(unavailable.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
  });

  it("points the terminal UI at /integrations instead of the .env file (ATO-345)", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    ddg.search.mockImplementation(async () => {
      throw new Error(CONNECT_TIMEOUT);
    });

    const err = (await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
      keyHelp: "integrations-hub",
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.message).toContain(
      "Free Exa searches ran out. Open /integrations in the terminal app and add an Exa key (https://dashboard.exa.ai/api-keys)",
    );
    // No desktop card, no file to edit, no restart in the terminal UI.
    expect(err.message).not.toContain("key card");
    expect(err.message).not.toContain("EXA_API_KEY=...");
    expect(err.message).not.toContain("restart");
    expect(err.message).toContain("Do not repeat this search");
    // The machine-readable signal is the same on every surface.
    expect(err.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
  });

  it("does not say the free searches ran out when Exa was only unreachable (ATO-345)", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new Error("curl: (7) Failed to connect to mcp.exa.ai port 443");
    });
    ddg.search.mockImplementation(async () => {
      throw new Error(CONNECT_TIMEOUT);
    });

    const err = (await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
      keyHelp: "integrations-hub",
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    expect(err.keyRequired?.reason).toBe("unreachable");
    expect(err.message).not.toContain("ran out");
    expect(err.message).toContain(
      "To fix it: open /integrations in the terminal app and add an Exa key (https://dashboard.exa.ai/api-keys)",
    );
  });

  it("says Exa was unreachable when it could not be reached either", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new Error("curl: (7) Failed to connect to mcp.exa.ai port 443");
    });
    ddg.search.mockImplementation(async () => {
      throw new Error(CONNECT_TIMEOUT);
    });

    const err = (await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.keyRequired?.reason).toBe("unreachable");
    expect(err.message).toContain("None of the search sites could be reached");
  });

  it("does not let a free-tier park hold back a key added afterwards", async () => {
    // The user hit the free limit, added EXA_API_KEY and restarted, as the
    // error told them to. The persisted park from the free tier must not
    // keep the keyed API from being asked.
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });
    const T0 = 5_000_000;

    await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0,
    });
    expect(cooldown.tagOf("exa")).toBe("keyless");

    exa.search.mockImplementation(async () => ({ results: [RESULT] }));
    const keyed = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "with a key" },
      env: EXA_KEYED,
      cooldown,
      now: () => T0 + 10_000,
    });

    expect(exa.search).toHaveBeenCalledTimes(2);
    expect(keyed.provider).toBe("exa");
    expect(keyed.degraded.some((note) => note.includes("skipped"))).toBe(false);
    expect(keyed.keyRequired).toBeUndefined();
    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("passes a Stop through as it is: no report, no key card", async () => {
    const { exa, ddg } = exaAndDdg();
    const controller = new AbortController();
    exa.search.mockImplementation(async () => {
      controller.abort();
      throw new Error("The operation was aborted");
    });

    const err = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: { ...makeOptions(), signal: controller.signal },
      env: {},
    }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(WebSearchUnavailableError);
    expect((err as Error).message).toBe("The operation was aborted");
    expect(ddg.search).not.toHaveBeenCalled();
  });
});

describe("an Exa primary with a key", () => {
  it("stays first in the chain", async () => {
    const exa = stubProvider("exa", async () => [RESULT]);
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
    });

    expect(out.provider).toBe("exa");
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).not.toHaveBeenCalled();
  });

  it("reports a keyed Exa failure as a note when DuckDuckGo answers", async () => {
    // The desktop drew this as a red failed row even though the search
    // went on to succeed. A covered failure is a note; the call is ok.
    const exa = stubProvider("exa", async () => {
      throw new Error("Exa returned HTTP 403");
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
    });

    expect(exa.search).toHaveBeenCalledOnce();
    expect(out.provider).toBe("duckduckgo");
    expect(out.results).toEqual([RESULT]);
    expect(out.degraded).toEqual(["exa failed: Exa returned HTTP 403"]);
  });

  it("never asks for a key: not on a 429, not when everything fails", async () => {
    const exa = stubProvider("exa", async () => {
      throw new WebSearchRateLimitedError("exa", null);
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    const config = makeConfig({ provider: "exa", fallback: ["duckduckgo"] });

    const out = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cooldown: createProviderCooldown(),
      now: () => 5_000_000,
    });
    expect(out.degraded).toEqual([
      "exa rate limited (HTTP 429), parked for 1m",
    ]);
    expect(out.keyRequired).toBeUndefined();

    ddg.search.mockImplementation(async () => {
      throw new Error("curl: (28) Connection timed out after 5002 milliseconds");
    });
    const err = (await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "next" },
      env: EXA_KEYED,
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;
    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.keyRequired).toBeUndefined();
    expect(err.message).not.toContain("dashboard.exa.ai");
    expect(err.message).toContain("web.search.provider");
  });
});

describe("a provider that cannot be reached (ATO-315)", () => {
  const CONNECT_TIMEOUT =
    "curl: (28) Connection timed out after 5002 milliseconds";
  const DDG_TIMED_OUT = `duckduckgo: could not connect, the connection timed out after 5 s (site unreachable from this network); ${CONNECT_TIMEOUT}`;
  const T0 = 7_000_000;

  function exaUpDdgDown() {
    const exa = stubProvider("exa", async () => [RESULT]);
    const ddg = stubProvider("duckduckgo", async () => {
      throw new Error(CONNECT_TIMEOUT);
    });
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    return { exa, ddg };
  }

  it("parks it, so the next searches do not pay the connect timeout again", async () => {
    const { ddg } = exaUpDdgDown();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: [] });
    const search = (query: string, at: number) =>
      runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query },
        env: {},
        cooldown,
        now: () => at,
      }).then(
        () => { throw new Error("expected every provider to be unreachable"); },
        (e: unknown) => e as WebSearchUnavailableError,
      );

    const first = await search("one", T0);
    expect(first).toBeInstanceOf(WebSearchUnavailableError);
    expect(first.failures).toEqual([DDG_TIMED_OUT]);

    const second = await search("two", T0 + 10_000);
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(second).toBeInstanceOf(WebSearchUnavailableError);
    expect(second.failures).toEqual([
      "duckduckgo: could not connect a moment ago (site unreachable from this network), next try in 1m 50s",
    ]);
    expect(second.message).toContain("None of the search sites could be reached");
  });

  it("probes an all-unreachable chain at most every 30 s", async () => {
    const { ddg } = exaUpDdgDown();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: [] });
    const search = (at: number) =>
      runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query: `q${at}` },
        env: {},
        cooldown,
        now: () => at,
      }).catch(() => undefined);

    await search(T0);
    await search(T0 + 10_000);
    expect(ddg.search).toHaveBeenCalledOnce();
    await search(T0 + 31_000);
    expect(ddg.search).toHaveBeenCalledTimes(2);
    // That probe failed too: the next 30 s are quiet again.
    await search(T0 + 45_000);
    expect(ddg.search).toHaveBeenCalledTimes(2);
  });

  it("counts only usable providers when deciding the chain is all unreachable", async () => {
    // brave without its key cannot be asked; it must not read as a
    // provider that is still up and so stop the probe.
    const { ddg } = exaUpDdgDown();
    const cooldown = createProviderCooldown();
    cooldown.parkUnreachable("duckduckgo", T0);

    await runWebSearchWithFallback({
      config: makeConfig({ provider: "duckduckgo", fallback: ["brave"] }),
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0 + 31_000,
    }).catch(() => undefined);

    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("drops a park from the other Exa tier before deciding to probe", async () => {
    // A keyless-tier park on Exa is void once a key is set, so the chain
    // is not all unreachable and DuckDuckGo stays parked.
    const exa = stubProvider("exa", async () => {
      throw new Error("Exa API returned HTTP 403");
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    const cooldown = createProviderCooldown();
    cooldown.parkUnreachable("exa", T0, "keyless");
    cooldown.parkUnreachable("duckduckgo", T0);

    await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cooldown,
      now: () => T0 + 31_000,
    }).catch(() => undefined);

    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).not.toHaveBeenCalled();
  });

  it("skips it in the searches that start after the failure, until the park ends", async () => {
    const { exa, ddg } = exaUpDdgDown();
    exa.search.mockImplementation(async () => {
      throw new Error("Exa API returned HTTP 403");
    });
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: ["exa"] });
    const search = (query: string, at: number) =>
      runWebSearchWithFallback({
        config,
        deps: {},
        options: { ...makeOptions(), query },
        env: EXA_KEYED,
        cooldown,
        now: () => at,
      }).then(
        () => { throw new Error("expected every provider to be unreachable"); },
        (e: unknown) => e as WebSearchUnavailableError,
      );

    const first = await search("one", T0);
    expect(first).toBeInstanceOf(WebSearchUnavailableError);
    expect(first.failures).toEqual([
      DDG_TIMED_OUT,
      "exa: Exa API returned HTTP 403",
    ]);
    expect(cooldown.reasonOf("duckduckgo", T0)).toBe("unreachable");

    const second = await search("two", T0 + 30_000);
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(second.failures).toEqual([
      "duckduckgo: could not connect a moment ago (site unreachable from this network), next try in 1m 30s",
      "exa: Exa API returned HTTP 403",
    ]);

    // The park is over: the provider is asked again.
    await search("three", T0 + 121_000);
    expect(ddg.search).toHaveBeenCalledTimes(2);
  });

  it("notes the park and serves from the next provider", async () => {
    const { exa, ddg } = exaUpDdgDown();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: ["exa"] });

    const first = await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: EXA_KEYED,
      cooldown,
      now: () => T0,
    });
    expect(first.provider).toBe("exa");
    expect(first.degraded).toEqual([
      `duckduckgo could not connect, skipped for 2m: ${CONNECT_TIMEOUT}`,
    ]);

    const second = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "next" },
      env: EXA_KEYED,
      cooldown,
      now: () => T0 + 60_000,
    });
    expect(second.provider).toBe("exa");
    expect(second.degraded).toEqual([
      "duckduckgo skipped: could not connect a moment ago, retrying in 1m",
    ]);
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(exa.search).toHaveBeenCalledTimes(2);
  });

  it("asks again when every provider was unreachable: a blip must not keep search off", async () => {
    const ddg = stubProvider("duckduckgo", async () => {
      throw new Error("curl: (6) Could not resolve host: html.duckduckgo.com");
    });
    vi.mocked(resolveProviderByName).mockReturnValue(ddg);
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: [] });

    await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0,
    }).catch(() => undefined);
    expect(cooldown.reasonOf("duckduckgo", T0)).toBe("unreachable");

    // The network is back by the next probe, 30 s later.
    ddg.search.mockImplementation(async () => ({ results: [RESULT] }));
    const out = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "back" },
      env: {},
      cooldown,
      now: () => T0 + 30_000,
    });

    expect(out.provider).toBe("duckduckgo");
    expect(out.results).toEqual([RESULT]);
    expect(ddg.search).toHaveBeenCalledTimes(2);
    expect(cooldown.isParked("duckduckgo", T0 + 30_000)).toBe(false);
  });

  it("tries keyless Exa again when it and DuckDuckGo were both unreachable", async () => {
    const exa = stubProvider("exa", async () => {
      throw new Error("curl: (7) Failed to connect to mcp.exa.ai port 443 after 4 ms: Connection refused");
    });
    const ddg = stubProvider("duckduckgo", async () => [RESULT]);
    vi.mocked(resolveProviderByName).mockImplementation((name) =>
      name === "exa" ? exa : ddg,
    );
    const cooldown = createProviderCooldown();
    cooldown.parkUnreachable("exa", T0, "keyless");
    cooldown.parkUnreachable("duckduckgo", T0);

    const err = (await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0 + 31_000,
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    // Only the first one is asked; the rest stay parked.
    expect(exa.search).toHaveBeenCalledOnce();
    expect(ddg.search).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.failures).toEqual([
      "exa: could not connect, the connection was refused (site unreachable from this network); curl: (7) Failed to connect to mcp.exa.ai port 443 after 4 ms: Connection refused",
      "duckduckgo: could not connect a moment ago (site unreachable from this network), next try in 1m 29s",
    ]);
    expect(err.keyRequired?.reason).toBe("unreachable");
    expect(err.message).toContain(
      "None of the search sites could be reached: check the internet connection, VPN or proxy.",
    );
  });

  it("forgets the park once the provider answers again", async () => {
    const { ddg } = exaUpDdgDown();
    const cooldown = createProviderCooldown();
    const config = makeConfig({ provider: "duckduckgo", fallback: [] });

    await runWebSearchWithFallback({
      config,
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0,
    }).catch(() => undefined);
    ddg.search.mockImplementation(async () => ({ results: [RESULT] }));
    const out = await runWebSearchWithFallback({
      config,
      deps: {},
      options: { ...makeOptions(), query: "back" },
      env: {},
      cooldown,
      now: () => T0 + 121_000,
    });

    expect(out.provider).toBe("duckduckgo");
    expect(cooldown.reasonOf("duckduckgo", T0 + 121_000)).toBeUndefined();
    expect(cooldown.tagOf("duckduckgo")).toBeUndefined();
  });

  it("does not park a host that answered slowly", async () => {
    const ddg = stubProvider("duckduckgo", async () => {
      throw new Error(
        "curl: (28) Operation timed out after 15001 milliseconds with 0 bytes received",
      );
    });
    vi.mocked(resolveProviderByName).mockReturnValue(ddg);
    const cooldown = createProviderCooldown();

    await runWebSearchWithFallback({
      config: makeConfig({ provider: "duckduckgo", fallback: [] }),
      deps: {},
      options: makeOptions(),
      env: {},
      cooldown,
      now: () => T0,
    }).catch(() => undefined);

    expect(cooldown.isParked("duckduckgo", T0)).toBe(false);
  });

  it("lists providers it could not ask in the all-failed report", async () => {
    exaUpDdgDown();

    const err = (await runWebSearchWithFallback({
      config: makeConfig({
        provider: "duckduckgo",
        fallback: ["brave", "searxng"],
      }),
      deps: {},
      options: makeOptions(),
      env: {},
    }).catch((e: unknown) => e)) as WebSearchUnavailableError;

    expect(err).toBeInstanceOf(WebSearchUnavailableError);
    expect(err.failures).toEqual([
      DDG_TIMED_OUT,
      "brave: skipped (no BRAVE_SEARCH_API_KEY set)",
      "searxng: skipped (no `web.search.searxng.instanceUrl` set)",
    ]);
    // The skipped ones were not tried, so they do not stop the report
    // from saying that nothing could be reached.
    expect(err.message).toContain("None of the search sites could be reached");
  });
});
