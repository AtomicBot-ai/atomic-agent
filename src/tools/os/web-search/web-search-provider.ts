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
  search(options: WebSearchProviderOptions): Promise<WebSearchResult[]>;
}

export interface WebSearchHttpDeps {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
}
