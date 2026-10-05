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
        anysearch: {
          endpoint: "https://api.anysearch.com/v1/search",
          apiKeyEnv: "ANYSEARCH_API_KEY",
          zone: null,
          language: null,
        },
        ...overrides,
      },
    },
  } as Pick<AtomicAgentConfig, "web">;
}

describe("checkMissingSearchKey", () => {
  it("warns on the shipped default: exa primary with no EXA_API_KEY", () => {
    const warning = checkMissingSearchKey({ config: makeConfig(), env: {} });

    expect(warning).not.toBeNull();
    expect(warning!.provider).toBe("exa");
    expect(warning!.apiKeyEnv).toBe("EXA_API_KEY");
    // The message must name the silent consequence, not just the missing key.
    expect(warning!.message).toContain("EXA_API_KEY");
    expect(warning!.message).toContain("duckduckgo");
    expect(warning!.message).toContain("429");
  });

  it("stays silent when the key is present", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig(),
        env: { EXA_API_KEY: "k" },
      }),
    ).toBeNull();
  });

  it("treats a whitespace-only key as missing", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig(),
        env: { EXA_API_KEY: "   " },
      }),
    ).not.toBeNull();
  });

  it("stays silent for keyless-by-design providers", () => {
    for (const provider of ["duckduckgo", "searxng"] as const) {
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

    expect(warning!.apiKeyEnv).toBe("BRAVE_SEARCH_API_KEY");
  });

  it("warns for an anysearch primary against its own env var (keyless tier)", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({ provider: "anysearch" }),
      env: {},
    });

    expect(warning).not.toBeNull();
    expect(warning!.apiKeyEnv).toBe("ANYSEARCH_API_KEY");
    expect(warning!.message).toContain("keyless tier");
  });

  it("stays silent when search is disabled outright", () => {
    expect(
      checkMissingSearchKey({
        config: makeConfig({ enabled: false }),
        env: {},
      }),
    ).toBeNull();
  });

  it("says so when no fallback is configured", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({ fallback: [] }),
      env: {},
    });

    expect(warning!.message).toContain("no fallback configured");
  });

  it("dedupes the primary out of the reported fallback chain", () => {
    const warning = checkMissingSearchKey({
      config: makeConfig({ fallback: ["exa", "duckduckgo"] }),
      env: {},
    });

    expect(warning!.fallback).toEqual(["duckduckgo"]);
  });
});
