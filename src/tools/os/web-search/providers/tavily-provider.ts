import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export interface TavilyProviderConfig {
  apiKeyEnv: string;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
}

export function createTavilyProvider(
  config: TavilyProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "tavily",
    async search(options) {
      const apiKey = process.env[config.apiKeyEnv]?.trim();
      if (!apiKey) {
        throw new Error(
          `Tavily search requires ${config.apiKeyEnv} in the process environment.`,
        );
      }
      const response = await searchHttp({
        url: TAVILY_SEARCH_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: options.query,
          max_results: options.maxResults,
        }),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      if (response.status >= 400) {
        throw new Error(`Tavily search returned HTTP ${response.status}`);
      }
      return parseTavilyJson(response.body, options.maxResults);
    },
  };
}

export function parseTavilyJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of parsed.results as TavilyResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    results.push({
      title: raw.title.trim(),
      url: raw.url.trim(),
      snippet: typeof raw.content === "string" ? raw.content.trim() : "",
      ...(typeof raw.publishedDate === "string"
        ? { published: raw.publishedDate.trim() }
        : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}