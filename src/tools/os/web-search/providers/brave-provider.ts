import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export interface BraveProviderConfig {
  apiKeyEnv: string;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
}

export function createBraveProvider(
  config: BraveProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "brave",
    async search(options) {
      const apiKey = process.env[config.apiKeyEnv]?.trim();
      if (!apiKey) {
        throw new Error(
          `Brave search requires ${config.apiKeyEnv} in the process environment.`,
        );
      }
      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", options.query);
      url.searchParams.set("count", String(options.maxResults));
      const response = await searchHttp({
        url: url.toString(),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      if (response.status >= 400) {
        throw new Error(`Brave search returned HTTP ${response.status}`);
      }
      return parseBraveJson(response.body, options.maxResults);
    },
  };
}

export function parseBraveJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as { web?: { results?: unknown } };
  const rawResults = parsed.web?.results;
  if (!Array.isArray(rawResults)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of rawResults as BraveResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    results.push({
      title: raw.title.trim(),
      url: raw.url.trim(),
      snippet: typeof raw.description === "string" ? raw.description.trim() : "",
      ...(typeof raw.age === "string" ? { published: raw.age.trim() } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}
