import { assertProviderStatus } from "./assert-provider-status.js";
import { isConnectFailure } from "./search-failure-report.js";
import { searchHttp } from "../transport/search-http.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

const CONTEXT_SEARCH_URL = "https://api.context.dev/v1/web/search";

interface ContextResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  highlights?: { code?: unknown; highlights?: unknown };
}

export function createContextProvider(
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "context",
    async search(options) {
      const apiKey = process.env.CONTEXT_DEV_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "Context search requires CONTEXT_DEV_API_KEY in the process environment.",
        );
      }
      if (options.query.length > 500) {
        throw new Error("Context search queries must be at most 500 characters.");
      }
      let status: number | undefined;
      try {
        const response = await searchHttp({
          url: CONTEXT_SEARCH_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query: options.query,
            numResults: options.maxResults,
            highlightsOptions: { enabled: true, maxCharacters: 1_000 },
            timeoutOpts: {
              milliseconds: Math.min(300_000, Math.max(1_000, options.timeoutMs - 1_000)),
              behavior: "fail",
            },
          }),
          timeoutMs: options.timeoutMs,
          cwd: options.cwd,
          signal: options.signal,
          maxRedirects: 0,
          runCommand: deps.runCommand,
          lookup: deps.lookup,
        });
        status = response.status;
        assertProviderStatus(response, "context", "Context search");
        const parsed = JSON.parse(response.body) as {
          results?: unknown;
          partial?: unknown;
        } | null;
        if (
          !parsed || !Array.isArray(parsed.results) || response.truncated ||
          (parsed.partial !== undefined && parsed.partial !== false)
        ) {
          throw new Error("Invalid Context search response");
        }
        const results: WebSearchResult[] = [];
        for (const raw of parsed.results as (ContextResult | null)[]) {
          if (!raw || typeof raw.title !== "string" || typeof raw.url !== "string") {
            continue;
          }
          if (
            raw.highlights !== undefined &&
            (!raw.highlights || typeof raw.highlights !== "object" ||
              typeof raw.highlights.code !== "string" ||
              (raw.highlights.code === "SUCCESS" &&
                !Array.isArray(raw.highlights.highlights)))
          ) {
            throw new Error("Invalid Context Highlights response");
          }
          const title = raw.title.trim();
          let url: URL;
          try {
            url = new URL(raw.url.trim());
          } catch {
            continue;
          }
          if (!title || !["http:", "https:"].includes(url.protocol) ||
            url.username || url.password) continue;
          const highlights =
            raw.highlights?.code === "SUCCESS" &&
            Array.isArray(raw.highlights.highlights)
              ? raw.highlights.highlights
                  .filter((value): value is string => typeof value === "string")
                  .join("\n").trim()
              : "";
          results.push({
            title,
            url: raw.url.trim(),
            snippet: highlights ||
              (typeof raw.description === "string"
                ? `[Search snippet; Highlights unavailable] ${raw.description.trim()}`
                : ""),
          });
          if (results.length >= options.maxResults) break;
        }
        if (parsed.results.length > 0 && results.length === 0) {
          throw new Error("Invalid Context search results");
        }
        return results;
      } catch (err) {
        if (err instanceof WebSearchRateLimitedError) throw err;
        if (status === undefined && isConnectFailure(err)) {
          throw new Error("Context search failed to connect.");
        }
        const detail = status !== undefined && status >= 400 ? ` (HTTP ${status})` : "";
        throw new Error(
          `Context search failed${detail}. No complete valid result was returned; ` +
          "check the API key, account credits, or provider availability.",
        );
      }
    },
  };
}
