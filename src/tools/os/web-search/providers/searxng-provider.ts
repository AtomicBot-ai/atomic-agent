import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
}

export interface SearxngProviderConfig {
  instanceUrl: string | null;
}

export function createSearxngProvider(
  config: SearxngProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "searxng",
    async search(options) {
      if (!config.instanceUrl) {
        throw new Error(
          "SearXNG search requires web.search.searxng.instanceUrl in config.",
        );
      }
      const url = new URL("/search", config.instanceUrl);
      url.searchParams.set("q", options.query);
      url.searchParams.set("format", "json");
      const response = await searchHttp({
        url: url.toString(),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        headers: { Accept: "application/json" },
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      if (response.status >= 400) {
        throw new Error(`SearXNG returned HTTP ${response.status}`);
      }
      return parseSearxngJson(response.body, options.maxResults);
    },
  };
}

export function parseSearxngJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of parsed.results as SearxngResult[]) {
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
