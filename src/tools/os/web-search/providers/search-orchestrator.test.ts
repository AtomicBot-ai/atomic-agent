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
        env: EXA_KEYED,
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
    // nothing was reported — and a whole campaign was quietly served by
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
 * ATO-120. Exa's keyless tier answered 429 under load and then 403
 * outright, and the shipped default (`provider: "exa"`, no key) sent it
 * a request before every search. Without a key Exa is skipped, so the
 * keyless chain serves the search and Exa's error can no longer become
 * the tool's.
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

  it("is never asked: the shipped default goes straight to DuckDuckGo", async () => {
    const { exa, ddg } = exaAndDdg();

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("duckduckgo");
    expect(out.results).toEqual([RESULT]);
    // A supported setup, not a degradation: nothing to report.
    expect(out.degraded).toEqual([]);
    expect(exa.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("treats a whitespace-only key as no key", async () => {
    const { exa } = exaAndDdg();

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      deps: {},
      options: makeOptions(),
      env: { EXA_API_KEY: "   " },
    });

    expect(out.provider).toBe("duckduckgo");
    expect(exa.search).not.toHaveBeenCalled();
  });

  it("still searches when no fallback is configured, through DuckDuckGo", async () => {
    // `fallback: []` used to mean "keyless Exa only". Skipping Exa must
    // not turn that config into one that cannot search at all.
    const { exa, ddg } = exaAndDdg();

    const out = await runWebSearchWithFallback({
      config: makeConfig({ provider: "exa", fallback: [] }),
      deps: {},
      options: makeOptions(),
      env: {},
    });

    expect(out.provider).toBe("duckduckgo");
    expect(exa.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
  });

  it("keeps the configured fallback order, with DuckDuckGo appended last", async () => {
    const { exa, searxng } = exaAndDdg();
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

    expect(exa.search).not.toHaveBeenCalled();
    expect(searxng.search).toHaveBeenCalledOnce();
    expect(out.provider).toBe("duckduckgo");
    expect(out.degraded).toEqual(["searxng failed: searxng blocked"]);
  });

  it("surfaces the keyless chain's own error, not Exa's, when everything fails", async () => {
    const { exa, ddg } = exaAndDdg();
    ddg.search.mockImplementation(async () => {
      throw new WebSearchBlockedError("duckduckgo", "ddg blocked");
    });

    await expect(
      runWebSearchWithFallback({
        config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
        deps: {},
        options: makeOptions(),
        env: {},
      }),
    ).rejects.toThrow("ddg blocked");
    expect(exa.search).not.toHaveBeenCalled();
  });

  it("stays first in the chain once the key is set", async () => {
    const { exa, ddg } = exaAndDdg();
    exa.search.mockImplementation(async () => [RESULT]);

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
    const { exa } = exaAndDdg();

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
});
