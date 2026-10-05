import type { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import type { HostLookup } from "../web-fetch-ssrf-guard.js";

export type WebSearchProviderName =
  | "duckduckgo"
  | "searxng"
  | "exa"
  | "brave"
  | "anysearch";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

/**
 * What a provider returns from one search attempt. `requestId` is the
 * upstream diagnostic id when the service exposes one (AnySearch
 * `request_id`) — surfaced on the tool result so operators can quote it
 * without digging through raw HTTP logs.
 */
export interface WebSearchProviderOutcome {
  results: WebSearchResult[];
  requestId?: string;
}

export interface WebSearchProviderOptions {
  query: string;
  maxResults: number;
  timeoutMs: number;
  cwd: string;
  signal: AbortSignal;
  /**
   * Optional AnySearch vertical routing (`tag` = `{domain}.{sub_domain}`).
   * Ignored by providers that do not support it.
   */
  tag?: string;
  /** Optional AnySearch structured params for a vertical `tag`. */
  params?: Record<string, string>;
  /** Optional AnySearch region: `cn` | `intl`. */
  zone?: string;
  /** Optional AnySearch language hint, e.g. `zh-CN` or `en`. */
  language?: string;
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(options: WebSearchProviderOptions): Promise<WebSearchProviderOutcome>;
}

export interface WebSearchHttpDeps {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
}
