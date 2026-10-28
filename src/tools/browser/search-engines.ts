import type { SearchInput } from "./browser-backend.js";

export type SearchEngine = NonNullable<SearchInput["engine"]>;

/** Results-page URL prefix per engine; the query is appended URL-encoded. */
export const SEARCH_URLS: Record<SearchEngine, string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

export function searchUrlFor(engine: SearchEngine, query: string): string {
  return `${SEARCH_URLS[engine]}${encodeURIComponent(query)}`;
}
