import { parseHTML } from "linkedom";

import { searchHttp } from "../transport/search-http.js";
import { WebSearchBlockedError } from "../web-search-errors.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

const BOT_CHALLENGE_MARKERS = [
  "g-recaptcha",
  "are you a human",
  "challenge-form",
  "anomaly",
];

interface QueryableElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): QueryableElement | null;
}

export function createDuckDuckGoProvider(
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "duckduckgo",
    async search(options) {
      const url = new URL(DUCKDUCKGO_HTML_URL);
      url.searchParams.set("q", options.query);
      const response = await searchHttp({
        url: url.toString(),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      if (response.status >= 400) {
        throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
      }
      const results = parseDuckDuckGoHtml(response.body, options.maxResults);
      if (results.length === 0 && isBotChallenge(response.body)) {
        throw new WebSearchBlockedError("duckduckgo");
      }
      return results;
    },
  };
}

/**
 * A blocked DDG page has no `.result__a` anchors AND carries a known challenge
 * marker. A genuine 0-result page has neither, so it is NOT flagged (returns
 * `[]` → "No search results."). Mirrors openclaw's ddg-client heuristic.
 */
export function isBotChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes("result__a")) return false;
  return BOT_CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

export function parseDuckDuckGoHtml(
  html: string,
  maxResults: number,
): WebSearchResult[] {
  const { document } = parseHTML(html);
  const results: WebSearchResult[] = [];
  const nodes = Array.from(
    document.querySelectorAll(".result"),
  ) as QueryableElement[];
  for (const node of nodes) {
    const link = node.querySelector(".result__a");
    if (!link) continue;
    const title = cleanText(link.textContent ?? "");
    const href = normaliseDuckDuckGoHref(link.getAttribute("href"));
    if (!title || !href) continue;
    const snippet = cleanText(
      node.querySelector(".result__snippet")?.textContent ?? "",
    );
    results.push({ title, url: href, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function normaliseDuckDuckGoHref(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    if (redirected) return redirected;
    if (url.hostname.endsWith("duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
