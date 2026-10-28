import { describe, expect, it } from "vitest";

import { createWebSearchDefaults } from "../config/web-config.js";
import { EXA_GET_KEY_URL } from "../tools/os/web-search/web-search-errors.js";
import { findIntegration } from "./integration-registry.js";
import {
  EXA_API_KEY_ENV,
  EXA_KEY_FIELD,
  exaIntegration,
  readExaSearchSetup,
} from "./exa-integration.js";

function ctx(present: string[], search?: Record<string, unknown>) {
  return {
    presentFields: new Set(present),
    configured: present.includes(EXA_KEY_FIELD),
    ...(search === undefined ? {} : { config: { web: { search } } }),
  };
}

const DEFAULT_SEARCH = createWebSearchDefaults() as unknown as Record<
  string,
  unknown
>;

describe("exaIntegration (ATO-345)", () => {
  it("is listed in the hub as Web search (Exa)", () => {
    expect(findIntegration("exa")?.label).toBe("Web search (Exa)");
  });

  it("stores one secret key under the env var web search reads by default", () => {
    const required = exaIntegration.fields.filter((f) => f.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.envVar).toBe(EXA_API_KEY_ENV);
    expect(required[0]?.secret).toBe(true);
    // The row and the provider must agree, or a saved key is never used.
    expect(createWebSearchDefaults().exa.apiKeyEnv).toBe(EXA_API_KEY_ENV);
  });

  it("links where the key is issued and applies without a restart", () => {
    expect(exaIntegration.docsUrl).toBe(EXA_GET_KEY_URL);
    expect(exaIntegration.appliesLive).toBe(true);
  });

  it("reports set and not set", () => {
    expect(exaIntegration.status(ctx([])).level).toBe("not_configured");
    expect(exaIntegration.status(ctx([EXA_KEY_FIELD])).level).toBe(
      "configured",
    );
  });

  it("says the saved key is not used when web search reads another variable", () => {
    const search = {
      ...DEFAULT_SEARCH,
      exa: { ...createWebSearchDefaults().exa, apiKeyEnv: "MY_EXA" },
    };
    const status = exaIntegration.status(ctx([EXA_KEY_FIELD], search));
    expect(status.detail).toBe(
      "key saved, but web search reads MY_EXA (web.search.exa.apiKeyEnv), not EXA_API_KEY",
    );
    expect(status.detail).not.toMatch(/used by web search/);
  });

  it("does not promise the key is used when Exa is not in the provider chain", () => {
    const search = { ...DEFAULT_SEARCH, provider: "duckduckgo", fallback: [] };
    const saved = exaIntegration.status(ctx([EXA_KEY_FIELD], search));
    expect(saved.detail).toBe(
      "key saved, but web search is set to duckduckgo; Exa is used only when it is web.search.provider or in web.search.fallback",
    );
    expect(exaIntegration.status(ctx([], search)).detail).toBe(
      "no key; web search is set to duckduckgo, not Exa",
    );
    // Exa as a fallback is in the chain.
    expect(
      readExaSearchSetup({
        web: { search: { ...search, fallback: ["exa"] } },
      }).inChain,
    ).toBe(true);
  });

  it("reads the shipped defaults as Exa primary on EXA_API_KEY", () => {
    expect(readExaSearchSetup({ web: { search: DEFAULT_SEARCH } })).toEqual({
      apiKeyEnv: "EXA_API_KEY",
      provider: "exa",
      inChain: true,
    });
    expect(exaIntegration.status(ctx([EXA_KEY_FIELD], DEFAULT_SEARCH)).detail).toBe(
      "key saved, used by web search",
    );
  });

  it("rejects a paste with spaces or non-ASCII characters", () => {
    const validate = exaIntegration.fields[0]!.validate!;
    expect(validate("abc def")).toMatch(/no spaces/);
    expect(validate("ключ")).toMatch(/ASCII/);
    expect(validate("0b1c2d3e-aaaa-bbbb-cccc-0123456789ab")).toBeUndefined();
  });
});
