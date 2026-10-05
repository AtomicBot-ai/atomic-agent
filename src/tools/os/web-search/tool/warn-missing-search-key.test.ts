import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../../../config/index.js";
import { checkMissingSearchKey } from "./warn-missing-search-key.js";

function makeConfig(
  overrides: Partial<AtomicAgentConfig["web"]["search"]> = {},
): Pick<AtomicAgentConfig, "web"> {
  return {
    web: {
      search: {
        enabled: true,
        provider: "exa",
        maxResults: 8,
        timeoutMs: 15_000,
        cacheTtlMinutes: 15,
        fallback: ["duckduckgo"],
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
  } as Pick<AtomicAgentConfig, "web">;
}

describe("checkMissingSearchKey", () => {
  it("stays silent on the shipped default: exa primary with no EXA_API_KEY", () => {
    // Keyless Exa is skipped and DuckDuckGo serves the search (ATO-120).
    // The old "expect HTTP 429" line went to stderr on every start and the
    // desktop logged it as an error for a setup that is working as shipped.
    expect(checkMissingSearchKey({ config: makeConfig(), env: {} })).toBeNull();
  });

  it("stays silent when the key is present", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig({ provider: "brave" }),
        env: { BRAVE_SEARCH_API_KEY: "k" },
      }),
    ).toBeNull();
  });

  it("treats a whitespace-only key as missing", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig({ provider: "brave" }),
        env: { BRAVE_SEARCH_API_KEY: "   " },
      }),
    ).not.toBeNull();
  });

  it("stays silent for providers that search without a key", () => {
    for (const provider of ["duckduckgo", "searxng", "exa"] as const) {
      expect(
        checkMissingSearchKey({ config: makeConfig({ provider }), env: {} }),
      ).toBeNull();
    }
  });

  it("warns for a brave primary against its own env var", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({ provider: "brave" }),
      env: {},
    });

    expect(warning!.provider).toBe("brave");
    expect(warning!.apiKeyEnv).toBe("BRAVE_SEARCH_API_KEY");
    // The message must name the consequence, not just the missing key.
    expect(warning!.message).toContain("BRAVE_SEARCH_API_KEY");
    expect(warning!.message).toContain("skipped entirely");
    expect(warning!.message).toContain("duckduckgo");
    expect(warning!.message).not.toContain("429");
  });

  it("stays silent when search is disabled outright", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig({ provider: "brave", enabled: false }),
        env: {},
      }),
    ).toBeNull();
  });

  it("says so when no fallback is configured", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({ provider: "brave", fallback: [] }),
      env: {},
    });

    expect(warning!.message).toContain("no other provider");
  });

  it("dedupes the primary out of the reported fallback chain", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({
        provider: "brave",
        fallback: ["brave", "duckduckgo"],
      }),
      env: {},
    });

    expect(warning!.fallback).toEqual(["duckduckgo"]);
  });
});
