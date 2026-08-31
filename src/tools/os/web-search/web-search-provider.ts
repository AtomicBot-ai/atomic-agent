import type { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import type { HostLookup } from "../web-fetch-ssrf-guard.js";

export type WebSearchProviderName = "duckduckgo" | "searxng" | "exa" | "brave" | "tavily";

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
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(options: WebSearchProviderOptions): Promise<WebSearchResult[]>;
}

export interface WebSearchHttpDeps {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
}
