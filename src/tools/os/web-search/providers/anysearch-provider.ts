import { assertProviderStatus } from "./assert-provider-status.js";
import { searchHttp } from "../transport/search-http.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchProviderOptions,
  WebSearchResult,
} from "../web-search-provider.js";

export interface AnySearchProviderConfig {
  /** REST search endpoint, default `https://api.anysearch.com/v1/search`. */
  endpoint: string;
  /** Env var holding an optional Bearer API key (`ANYSEARCH_API_KEY`). */
  apiKeyEnv: string;
  /** Optional default region (`cn` | `intl`). Overridden per-call by `options.zone`. */
  zone: string | null;
  /** Optional default language hint. Overridden per-call by `options.language`. */
  language: string | null;
}

interface AnySearchEnvelope {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
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
 * sent as `Authorization: Bearer …` for higher rate limits. Optional
 * vertical routing (`tag` / `params` / `zone` / `language`) follows the
 * public REST contract used by OpenClaw and HyperResearcher. Batch search
 * and URL extract remain in the bundled `anysearch` starter skill.
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
        body: JSON.stringify(buildSearchBody(options, config)),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });

      // Quota exhaustion (402) is a standing rate limit — park via the
      // orchestrator instead of treating it as a hard transport failure.
      if (response.status === 402) {
        throw new WebSearchRateLimitedError(
          "anysearch",
          response.retryAfterMs,
          redactSecrets(
            `AnySearch returned HTTP 402 (quota exhausted)${requestIdSuffix(response.body)}`,
            apiKey,
          ),
        );
      }

      try {
        assertProviderStatus(response, "anysearch", "AnySearch");
      } catch (err) {
        // OpenClaw / QwenPaw: never surface a Bearer that an upstream
        // echoed into a 4xx body / retry-after caption.
        if (err instanceof WebSearchRateLimitedError) {
          throw new WebSearchRateLimitedError(
            err.provider,
            err.retryAfterMs,
            redactSecrets(err.message, apiKey),
          );
        }
        throw new Error(redactSecrets((err as Error).message, apiKey));
      }
      try {
        return parseAnySearchJson(response.body, options.maxResults);
      } catch (err) {
        throw new Error(redactSecrets((err as Error).message, apiKey));
      }
    },
  };
}

export function buildSearchBody(
  options: Pick<
    WebSearchProviderOptions,
    "query" | "maxResults" | "tag" | "params" | "zone" | "language"
  >,
  config: Pick<AnySearchProviderConfig, "zone" | "language">,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: options.query,
    max_results: clampMaxResults(options.maxResults),
  };
  if (options.tag?.trim()) body.tag = options.tag.trim();
  if (options.params && Object.keys(options.params).length > 0) {
    body.params = options.params;
  }
  const zone = options.zone?.trim() || config.zone?.trim() || "";
  if (zone) body.zone = zone;
  const language = options.language?.trim() || config.language?.trim() || "";
  if (language) body.language = language;
  return body;
}

export function parseAnySearchJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  let parsed: AnySearchEnvelope;
  try {
    parsed = JSON.parse(body) as AnySearchEnvelope;
  } catch {
    throw new Error("AnySearch returned invalid JSON");
  }
  if (parsed.code !== undefined && parsed.code !== 0) {
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : `AnySearch returned code ${String(parsed.code)}`;
    const suffix =
      typeof parsed.request_id === "string" && parsed.request_id
        ? ` (request_id: ${parsed.request_id})`
        : "";
    throw new Error(`${message}${suffix}`);
  }
  const rawResults = parsed.data?.results;
  if (!Array.isArray(rawResults)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of rawResults as AnySearchResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    const title = raw.title.trim();
    const url = sanitizeResultUrl(raw.url.trim());
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

/**
 * Drop embedded `user:pass@` from result URLs (OpenClaw web-search plugin
 * hardening). Credentials in a URL that reaches the model are a prompt /
 * transcript leak; the page itself is still reachable without them.
 */
export function sanitizeResultUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Absolute URLs only — leave relative / opaque strings alone.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
  }
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

function requestIdSuffix(body: string): string {
  try {
    const parsed = JSON.parse(body) as { request_id?: unknown };
    if (typeof parsed.request_id === "string" && parsed.request_id) {
      return ` (request_id: ${parsed.request_id})`;
    }
  } catch {
    // ignore
  }
  return "";
}

/** Never leak a Bearer token that an upstream echoed into an error body. */
export function redactSecrets(message: string, apiKey?: string): string {
  let out = message;
  // Exact known key first so a short key is not left as `as_sk_[REDACTED]`.
  if (apiKey && apiKey.length >= 8) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    // AnySearch key shape + generic URL userinfo (OpenClaw-style).
    .replace(/\bas_sk_[A-Za-z0-9._\-]+/g, "as_sk_[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@");
}
