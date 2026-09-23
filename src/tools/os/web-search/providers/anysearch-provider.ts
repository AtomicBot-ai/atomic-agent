import { assertProviderStatus } from "./assert-provider-status.js";
import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

export interface AnySearchProviderConfig {
  /** REST search endpoint, default `https://api.anysearch.com/v1/search`. */
  endpoint: string;
  /** Env var holding an optional Bearer API key (`ANYSEARCH_API_KEY`). */
  apiKeyEnv: string;
}

interface AnySearchEnvelope {
  code?: unknown;
  message?: unknown;
  data?: {
    results?: unknown;
  };
}

interface AnySearchResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  content?: unknown;
}

const CLIENT_HEADER = "atomic-agent/web-search";

/**
 * AnySearch general-web provider for `os.web.search`.
 *
 * Anonymous by default (no `Authorization` header). When
 * `ANYSEARCH_API_KEY` (or the configured env name) is set, the key is
 * sent as `Authorization: Bearer …` for higher rate limits. Vertical
 * domain routing, batch search, and URL extract live in the bundled
 * `anysearch` starter skill — this provider only covers the shared
 * `os.web.search` contract.
 */
export function createAnySearchProvider(
  config: AnySearchProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "anysearch",
    async search(options) {
      const apiKey = process.env[config.apiKeyEnv]?.trim();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Anysearch-Client": CLIENT_HEADER,
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await searchHttp({
        url: config.endpoint,
        method: "POST",
        headers,
        body: JSON.stringify({
          query: options.query,
          max_results: clampMaxResults(options.maxResults),
        }),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      assertProviderStatus(response, "anysearch", "AnySearch");
      return parseAnySearchJson(response.body, options.maxResults);
    },
  };
}

export function parseAnySearchJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as AnySearchEnvelope;
  if (parsed.code !== undefined && parsed.code !== 0) {
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : `AnySearch returned code ${String(parsed.code)}`;
    throw new Error(message);
  }
  const rawResults = parsed.data?.results;
  if (!Array.isArray(rawResults)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of rawResults as AnySearchResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    const title = raw.title.trim();
    const url = raw.url.trim();
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet: extractSnippet(raw),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

function extractSnippet(raw: AnySearchResult): string {
  if (typeof raw.snippet === "string" && raw.snippet.trim()) {
    return raw.snippet.trim();
  }
  if (typeof raw.content === "string" && raw.content.trim()) {
    return raw.content.replace(/\s+/g, " ").trim().slice(0, 500);
  }
  return "";
}

function clampMaxResults(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(Math.trunc(n), 10));
}
