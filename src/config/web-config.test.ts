import { describe, expect, it } from "vitest";
import {
  createWebFetchDefaults,
  createWebSearchDefaults,
  parseWebFetchConfig,
  parseWebSearchConfig,
  parseWebSearchFallback,
  parseWebSearchProviderName,
  prepareWebSearchInputs,
} from "./web-config.js";
import {
  ConfigValidationError,
  parseUserConfigFile,
  parseWebSearchFallback as parseComposedFallback,
  parseWebSearchProviderName as parseComposedProvider,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "./config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected web configuration fixture validation to reject");
}

function parseSearch(raw: Record<string, unknown>) {
  const defaults = createWebSearchDefaults();
  return parseWebSearchConfig(prepareWebSearchInputs(raw, () => defaults), () => defaults);
}

function parseFetch(raw: Record<string, unknown>) {
  const defaults = createWebFetchDefaults();
  return parseWebFetchConfig(raw, () => defaults);
}

describe("web configuration ownership and compatibility", () => {
  it("preserves root helper and validation-error identity", () => {
    expect(parseComposedProvider).toBe(parseWebSearchProviderName);
    expect(parseComposedFallback).toBe(parseWebSearchFallback);
    expect(ConfigValidationError).toBe(OwnedValidationError);
    for (const provider of ["duckduckgo", "searxng", "exa", "brave"]) {
      expect(parseWebSearchProviderName(provider, "synthetic.provider")).toBe(provider);
    }
    expect(thrownError(() => parseWebSearchProviderName("EXA", "synthetic.provider")))
      .toMatchObject({ field: "synthetic.provider", reason: 'expected one of duckduckgo|searxng|exa|brave, got "EXA"' });
  });

  it("creates fresh mutable nested defaults and retains property order", () => {
    const search = createWebSearchDefaults();
    const otherSearch = createWebSearchDefaults();
    const fetch = createWebFetchDefaults();
    const otherFetch = createWebFetchDefaults();
    expect(search).toStrictEqual({
      enabled: true, provider: "exa", maxResults: 8, timeoutMs: 15_000,
      cacheTtlMinutes: 60, persistCache: true, fallback: ["duckduckgo"],
      searxng: { instanceUrl: null },
      exa: { endpoint: "https://mcp.exa.ai/mcp", apiEndpoint: "https://api.exa.ai/search", apiKeyEnv: "EXA_API_KEY" },
      brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
    });
    expect(fetch).toStrictEqual({ timeoutMs: 30_000, connectTimeoutMs: 10_000, maxRetries: 2, retryBaseDelayMs: 500, retryMaxDelayMs: 5_000 });
    expect(Object.keys(search)).toEqual(["enabled", "provider", "maxResults", "timeoutMs", "cacheTtlMinutes", "persistCache", "fallback", "searxng", "exa", "brave"]);
    expect(Object.keys(fetch)).toEqual(["timeoutMs", "connectTimeoutMs", "maxRetries", "retryBaseDelayMs", "retryMaxDelayMs"]);
    expect(search).not.toBe(otherSearch);
    expect(search.fallback).not.toBe(otherSearch.fallback);
    expect(search.searxng).not.toBe(otherSearch.searxng);
    expect(search.exa).not.toBe(otherSearch.exa);
    expect(search.brave).not.toBe(otherSearch.brave);
    expect(fetch).not.toBe(otherFetch);
    search.fallback.push("brave");
    search.exa.endpoint = "synthetic endpoint";
    search.searxng.instanceUrl = "synthetic instance";
    search.brave.apiKeyEnv = "synthetic key";
    fetch.maxRetries = 0;
    expect(createWebSearchDefaults()).toStrictEqual(otherSearch);
    expect(createWebFetchDefaults()).toStrictEqual(otherFetch);
  });

  it("returns fresh search/fetch output blocks and nested objects on every root parse", () => {
    const first = parseUserConfigFile({}).web;
    const second = parseUserConfigFile({ web: { search: null, fetch: null } }).web;
    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
    expect(first.search).not.toBe(second.search);
    expect(first.search).not.toBe(USER_CONFIG_DEFAULTS.web.search);
    expect(first.search.fallback).not.toBe(second.search.fallback);
    expect(first.search.fallback).not.toBe(USER_CONFIG_DEFAULTS.web.search.fallback);
    expect(first.search.searxng).not.toBe(second.search.searxng);
    expect(first.search.exa).not.toBe(second.search.exa);
    expect(first.search.brave).not.toBe(second.search.brave);
    expect(first.fetch).not.toBe(second.fetch);
    expect(first.fetch).not.toBe(USER_CONFIG_DEFAULTS.web.fetch);
  });

  it("distinguishes direct fallback omission from root null defaults and preserves chain order", () => {
    expect(parseWebSearchFallback(undefined, "exa", "synthetic.fallback")).toEqual([]);
    expect(parseWebSearchFallback([], "exa", "synthetic.fallback")).toEqual([]);
    expect(parseWebSearchFallback(["brave", "exa", "searxng", "brave", "duckduckgo", "searxng"], "exa", "synthetic.fallback"))
      .toEqual(["brave", "searxng", "duckduckgo"]);
    const error = thrownError(() => parseWebSearchFallback(null, "exa", "synthetic.fallback"));
    expect(error).toBeInstanceOf(OwnedValidationError);
    expect(error).toMatchObject({ field: "synthetic.fallback", reason: "expected an array of provider names, got null" });
    expect(parseUserConfigFile({ web: { search: { fallback: null } } }).web.search.fallback).toEqual(["duckduckgo"]);
    expect(parseUserConfigFile({ web: { search: { fallback: [] } } }).web.search.fallback).toEqual([]);
    expect(thrownError(() => parseWebSearchFallback(["brave", "EXA"], "exa", "synthetic.fallback")))
      .toMatchObject({ field: "synthetic.fallback[1]" });
  });

  it("keeps endpoints and key-environment names as nonempty strings without URL/name policy", () => {
    const raw = {
      enabled: "OFF", provider: "searxng", maxResults: "2.0", timeoutMs: "1e3",
      cacheTtlMinutes: "0", persistCache: "No", fallback: [],
      searxng: { instanceUrl: " " },
      exa: { endpoint: "not a URL", apiEndpoint: " ", apiKeyEnv: "a key with spaces" },
      brave: { apiKeyEnv: " " },
    };
    const expected = {
      ...raw, enabled: false, maxResults: 2, timeoutMs: 1000,
      cacheTtlMinutes: 0, persistCache: false,
    };
    expect(parseSearch(raw)).toStrictEqual(expected);
    expect(parseUserConfigFile({ web: { search: raw } }).web.search).toStrictEqual(expected);
    const fetch = { timeoutMs: "1", connectTimeoutMs: "2", maxRetries: "0", retryBaseDelayMs: "9", retryMaxDelayMs: "3" };
    const expectedFetch = { timeoutMs: 1, connectTimeoutMs: 2, maxRetries: 0, retryBaseDelayMs: 9, retryMaxDelayMs: 3 };
    expect(parseFetch(fetch)).toStrictEqual(expectedFetch);
    expect(parseUserConfigFile({ web: { fetch } }).web.fetch).toStrictEqual(expectedFetch);
  });

  it.each([false, 42, "primitive", [], new Date(0)])("retains permissive field lookup for a non-plain block (%j)", (block) => {
    expect(parseUserConfigFile({ web: { search: block, fetch: block } }).web)
      .toStrictEqual(parseUserConfigFile({}).web);
  });

  it.each([
    { search: { maxResults: 0 }, field: "web.search.maxResults", reason: "expected positive integer, got 0" },
    { search: { enabled: false, maxResults: 21 }, field: "web.search.maxResults", reason: "expected integer in [1, 20], got 21" },
    { search: { cacheTtlMinutes: 1441 }, field: "web.search.cacheTtlMinutes", reason: "expected integer in [0, 1440], got 1441" },
    { search: { persistCache: " true " }, field: "web.search.persistCache", reason: 'expected boolean, got " true "' },
    { search: { searxng: { instanceUrl: "" } }, field: "web.search.searxng.instanceUrl", reason: 'expected non-empty string, got ""' },
    { search: { exa: { endpoint: "" } }, field: "web.search.exa.endpoint", reason: 'expected non-empty string, got ""' },
  ])("preserves search owner/root errors for $field", ({ search, field, reason }) => {
    for (const error of [thrownError(() => parseSearch(search)), thrownError(() => parseUserConfigFile({ web: { search } }))]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it.each([
    { fetch: { timeoutMs: 0 }, field: "web.fetch.timeoutMs", reason: "expected positive integer, got 0" },
    { fetch: { connectTimeoutMs: "10ms" }, field: "web.fetch.connectTimeoutMs", reason: 'expected positive integer, got "10ms"' },
    { fetch: { maxRetries: 6 }, field: "web.fetch.maxRetries", reason: "expected integer in [0, 5], got 6" },
    { fetch: { maxRetries: -1 }, field: "web.fetch.maxRetries", reason: "expected non-negative integer, got -1" },
    { fetch: { retryBaseDelayMs: 0 }, field: "web.fetch.retryBaseDelayMs", reason: "expected positive integer, got 0" },
    { fetch: { retryMaxDelayMs: 0 }, field: "web.fetch.retryMaxDelayMs", reason: "expected positive integer, got 0" },
  ])("preserves fetch owner/root errors for $field", ({ fetch, field, reason }) => {
    for (const error of [thrownError(() => parseFetch(fetch)), thrownError(() => parseUserConfigFile({ web: { fetch } }))]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it.each([
    { raw: { web: { search: { provider: "EXA", maxResults: 0 } }, webhooks: [] }, field: "web.search.provider" },
    { raw: { web: { search: { maxResults: 0 } }, webhooks: [] }, field: "webhooks" },
    { raw: { web: { search: { maxResults: 0 } }, agent: { tokenBudget: 0 }, http: { enabled: "bad" } }, field: "agent.tokenBudget" },
    { raw: { web: { search: { maxResults: 0 } }, http: { enabled: "bad" } }, field: "http.enabled" },
    { raw: { web: { search: { maxResults: 0 }, fetch: { timeoutMs: 0 } } }, field: "web.search.maxResults" },
  ])("retains root validation phase ordering at $field", ({ raw, field }) => {
    expect(thrownError(() => parseUserConfigFile(raw))).toMatchObject({ field });
  });

  it("defers search-field validation until after the provider preparation phase", () => {
    const events: string[] = [];
    const raw = {
      get provider() { events.push("provider"); return "exa"; },
      get searxng() { events.push("searxng"); return {}; },
      get exa() { events.push("exa"); return {}; },
      get brave() { events.push("brave"); return {}; },
      get enabled() { events.push("enabled"); return "bad"; },
    };
    const prepared = prepareWebSearchInputs(raw, createWebSearchDefaults);
    expect(events).toEqual(["provider", "searxng", "exa", "brave"]);
    expect(thrownError(() => parseWebSearchConfig(prepared, createWebSearchDefaults))).toMatchObject({ field: "web.search.enabled" });
    expect(events).toEqual(["provider", "searxng", "exa", "brave", "enabled"]);
  });

  it("short-circuits default lookups for every explicitly supplied field", () => {
    const originalWeb = USER_CONFIG_DEFAULTS.web;
    const search = { ...createWebSearchDefaults(), searxng: { instanceUrl: "synthetic instance" } };
    const fetch = { ...createWebFetchDefaults() };
    const noSearchDefaults = () => { throw new Error("search defaults must not be read"); };
    const noFetchDefaults = () => { throw new Error("fetch defaults must not be read"); };
    expect(parseWebSearchConfig(prepareWebSearchInputs(search, noSearchDefaults), noSearchDefaults)).toStrictEqual(search);
    expect(parseWebFetchConfig(fetch, noFetchDefaults)).toStrictEqual(fetch);
    try {
      USER_CONFIG_DEFAULTS.web = {
        get search() { return noSearchDefaults(); },
        get fetch() { return noFetchDefaults(); },
      };
      expect(parseUserConfigFile({ web: { search, fetch } }).web).toStrictEqual({ search, fetch });
    } finally {
      USER_CONFIG_DEFAULTS.web = originalWeb;
    }
  });

  it("performs a separate current-default lookup for each omitted field in the existing order", () => {
    const originalWeb = USER_CONFIG_DEFAULTS.web;
    const events: string[] = [];
    const search = createWebSearchDefaults();
    const fetch = createWebFetchDefaults();
    try {
      USER_CONFIG_DEFAULTS.web = {
        get search() { events.push("search"); return search; },
        get fetch() { events.push("fetch"); return fetch; },
      };
      parseUserConfigFile({});
      expect(events).toEqual([...Array<string>(11).fill("search"), ...Array<string>(5).fill("fetch")]);
    } finally {
      USER_CONFIG_DEFAULTS.web = originalWeb;
    }
  });

  it.each([
    { instance: null, reads: 1, expected: null },
    { instance: undefined, reads: 2, expected: null },
    { instance: " synthetic instance ", reads: 3, expected: " synthetic instance " },
  ])("retains repeated searxng getter accesses and ignores defaults ($reads reads)", ({ instance, reads, expected }) => {
    const originalWeb = USER_CONFIG_DEFAULTS.web;
    const search = createWebSearchDefaults();
    search.searxng.instanceUrl = "mutated default must be ignored";
    let accesses = 0;
    const searxng = { get instanceUrl() { accesses += 1; return instance; } };
    try {
      USER_CONFIG_DEFAULTS.web = { search, fetch: createWebFetchDefaults() };
      expect(parseUserConfigFile({ web: { search: { searxng } } }).web.search.searxng.instanceUrl).toBe(expected);
      expect(accesses).toBe(reads);
      expect(parseUserConfigFile({}).web.search.searxng.instanceUrl).toBeNull();
    } finally {
      USER_CONFIG_DEFAULTS.web = originalWeb;
    }
  });

  it("observes nested and whole-web default replacements within one call without changing the prepared provider", () => {
    const originalWeb = USER_CONFIG_DEFAULTS.web;
    const first = createWebSearchDefaults();
    const nested = { ...createWebSearchDefaults(), enabled: false };
    const whole = { ...createWebSearchDefaults(), provider: parseWebSearchProviderName("brave", "fixture"), maxResults: 5, timeoutMs: 31, fallback: [parseWebSearchProviderName("brave", "fixture")] };
    const nextFetch = { ...createWebFetchDefaults(), timeoutMs: 41 };
    const events: string[] = [];
    try {
      USER_CONFIG_DEFAULTS.web = { search: first, fetch: createWebFetchDefaults() };
      const config = parseUserConfigFile({ web: {
        search: {
          get enabled() { events.push("replace nested search"); USER_CONFIG_DEFAULTS.web.search = nested; return undefined; },
          get maxResults() { events.push("replace whole web"); USER_CONFIG_DEFAULTS.web = { search: whole, fetch: createWebFetchDefaults() }; return undefined; },
        },
        fetch: {
          get timeoutMs() { events.push("replace nested fetch"); USER_CONFIG_DEFAULTS.web.fetch = nextFetch; return undefined; },
        },
      } });
      expect(events).toEqual(["replace nested search", "replace whole web", "replace nested fetch"]);
      expect(config.web.search.provider).toBe("exa");
      expect(config.web.search.enabled).toBe(false);
      expect(config.web.search.maxResults).toBe(5);
      expect(config.web.search.timeoutMs).toBe(31);
      expect(config.web.search.fallback).toEqual(["brave"]);
      expect(config.web.fetch.timeoutMs).toBe(41);
      expect(config.web.fetch).not.toBe(nextFetch);
      expect(config.web.search).not.toBe(whole);
      whole.timeoutMs = 47;
      nextFetch.timeoutMs = 53;
      expect(config.web.search.timeoutMs).toBe(31);
      expect(config.web.fetch.timeoutMs).toBe(41);
    } finally {
      USER_CONFIG_DEFAULTS.web = originalWeb;
    }
  });
});
