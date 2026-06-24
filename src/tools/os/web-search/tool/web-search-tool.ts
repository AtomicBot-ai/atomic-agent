import { compressToolResult } from "../../../../compressor/result-compressor.js";
import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  runCommand as defaultRunCommand,
} from "../../../../sandbox/command-runner.js";
import type { ToolDefinition } from "../../../tool-registry.js";
import type { HostLookup } from "../../web-fetch-ssrf-guard.js";
import { runWebSearchWithFallback } from "../providers/index.js";
import { createSearchCache } from "../transport/search-cache.js";
import type { WebSearchResult } from "../web-search-provider.js";

const TOOL_NAME = "os.web.search";
const MAX_RESULTS_CAP = 20;

export interface OsWebSearchOptions {
  config: Pick<AtomicAgentConfig, "web">;
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
}

interface WebSearchArgs {
  query: string;
  maxResults: number;
}

export function buildOsWebSearchTool(options: OsWebSearchOptions): ToolDefinition {
  // Per-runtime cache lives in this closure (NOT a global singleton). It
  // persists across tool invocations so repeated identical queries skip the
  // HTTP round-trip — the primary defence against provider rate-limiting.
  const cfg0 = options.config.web.search;
  const cache = createSearchCache({ ttlMs: cfg0.cacheTtlMinutes * 60_000 });
  return {
    name: TOOL_NAME,
    description:
      "Search the web through the configured provider and return compact " +
      "title/url/snippet results. Default provider is keyless Exa with a " +
      "DuckDuckGo fallback; SearXNG is keyless, Exa/Brave use an environment " +
      "API key when present. " +
      "Use os.web.fetch to read a chosen result page.",
    readonly: true,
    async run(rawArgs, ctx) {
      const cfg = options.config.web.search;
      if (!cfg.enabled) {
        return compressToolResult({
          tool: TOOL_NAME,
          status: "error",
          output: "os.web.search is disabled by config (`web.search.enabled = false`).",
          details: { provider: cfg.provider },
        });
      }
      const args = parseArgs(rawArgs, cfg.maxResults);
      try {
        const outcome = await runWebSearchWithFallback({
          config: options.config,
          deps: {
            runCommand: options.runCommand,
            lookup: options.lookup,
          },
          options: {
            query: args.query,
            maxResults: args.maxResults,
            timeoutMs: cfg.timeoutMs,
            cwd: ctx.workingDir,
            signal: ctx.signal,
          },
          cache,
        });
        return compressToolResult(
          {
            tool: TOOL_NAME,
            status: "ok",
            output: renderResults(outcome.results),
            details: {
              provider: outcome.provider,
              fromCache: outcome.fromCache,
              query: args.query,
              results: outcome.results,
            },
          },
          {
            maxSummaryLength: 12_000,
            maxTailLines: Number.MAX_SAFE_INTEGER,
          },
        );
      } catch (err) {
        return compressToolResult({
          tool: TOOL_NAME,
          status: "error",
          output: (err as Error).message,
          details: {
            provider: cfg.provider,
            query: args.query,
          },
        });
      }
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
  defaultMaxResults: number,
): WebSearchArgs {
  const query = rawArgs.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`${TOOL_NAME}: \`query\` must be a non-empty string`);
  }
  let maxResults = defaultMaxResults;
  if (typeof rawArgs.maxResults === "number" && Number.isFinite(rawArgs.maxResults)) {
    maxResults = Math.trunc(rawArgs.maxResults);
  }
  maxResults = Math.min(MAX_RESULTS_CAP, Math.max(1, maxResults));
  return { query: query.trim(), maxResults };
}

function renderResults(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return "No search results.";
  return results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `URL: ${result.url}`];
      if (result.published) lines.push(`Published: ${result.published}`);
      if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
