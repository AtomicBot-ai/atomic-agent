import { assertProviderStatus } from "./assert-provider-status.js";
import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
/**
 * Keenable names the calling app by this header. The public endpoint
 * answers HTTP 400 without it.
 */
const KEENABLE_APP_TITLE = "atomic-agent";

export interface KeenableProviderConfig {
  apiKeyEnv: string;
}

interface KeenableResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}

export function createKeenableProvider(
  config: KeenableProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "keenable",
    async search(options) {
      // Works without a key on the public endpoint; a key only raises the
      // rate limit.
      const apiKey = process.env[config.apiKeyEnv]?.trim();
      const response = await searchHttp({
        url: apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Keenable-Title": KEENABLE_APP_TITLE,
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify({
          query: options.query,
          max_results: options.maxResults,
        }),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      assertProviderStatus(response, "keenable", "Keenable");
      return parseKeenableJson(response.body, options.maxResults);
    },
  };
}

export function parseKeenableJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of parsed.results as KeenableResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    results.push({
      title: raw.title.trim(),
      url: raw.url.trim(),
      // `snippet` is page text with line breaks, often a few thousand
      // characters: flattened and capped like Exa's page text.
      snippet:
        typeof raw.snippet === "string"
          ? raw.snippet.replace(/\s+/g, " ").trim().slice(0, 500)
          : "",
    });
    if (results.length >= maxResults) break;
  }
  return results;
}
