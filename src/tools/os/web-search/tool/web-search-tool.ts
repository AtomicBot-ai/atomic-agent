import { join } from "node:path";

import { compressToolResult } from "../../../../compressor/result-compressor.js";
import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  runCommand as defaultRunCommand,
} from "../../../../sandbox/command-runner.js";
import type { ToolDefinition } from "../../../tool-registry.js";
import type { HostLookup } from "../../web-fetch-ssrf-guard.js";
import { runWebSearchWithFallback } from "../providers/index.js";
import {
  createPersistentProviderCooldown,
  createProviderCooldown,
} from "../transport/provider-cooldown.js";
import {
  createPersistentSearchCache,
  createSearchCache,
} from "../transport/search-cache.js";
import type { WebSearchResult } from "../web-search-provider.js";
import { checkMissingSearchKey } from "./warn-missing-search-key.js";

const TOOL_NAME = "os.web.search";
const MAX_RESULTS_CAP = 20;

/** `<stateDir>/` files backing the persistent cache and cooldown (#256). */
const CACHE_FILE_NAME = "web-search-cache.json";
const COOLDOWN_FILE_NAME = "web-search-cooldown.json";

export interface OsWebSearchOptions {
  config: Pick<AtomicAgentConfig, "web">;
  /**
   * Absolute state directory backing the persistent result cache and
   * provider cooldown (#256). Omitted — or opted out via
   * `web.search.persistCache: false` — both stay in-memory and die with
   * the process, the pre-#256 behaviour.
   */
  stateDir?: string;
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  /** Process env source for the missing-key check; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Warning sink; defaults to stderr. Injectable for tests. */
  warn?: (message: string) => void;
}

interface WebSearchArgs {
  query: string;
  maxResults: number;
}

export function buildOsWebSearchTool(options: OsWebSearchOptions): ToolDefinition {
  // The cache lives in this closure (NOT a global singleton). It persists
  // across tool invocations so repeated identical queries skip the HTTP
  // round-trip — the primary defence against provider rate-limiting. Given
  // a `stateDir` (unless `web.search.persistCache` opts out) it is also
  // mirrored to disk, so a per-task process starts warm instead of
  // re-spending quota on queries the last process already answered (#256).
  const cfg0 = options.config.web.search;
  const persistDir = cfg0.persistCache ? options.stateDir : undefined;
  const ttlMs = cfg0.cacheTtlMinutes * 60_000;
  const cache =
    persistDir === undefined
      ? createSearchCache({ ttlMs })
      : createPersistentSearchCache({
          ttlMs,
          filePath: join(persistDir, CACHE_FILE_NAME),
        });
  // Same lifetime and same reason as the cache: parks and strikes are
  // facts about the last few minutes, whether those minutes belonged to
  // this process or to the one that just exited (#256).
  const cooldown =
    persistDir === undefined
      ? createProviderCooldown()
      : createPersistentProviderCooldown({
          filePath: join(persistDir, COOLDOWN_FILE_NAME),
        });

  // Emitted once at construction, not per search: a keyless primary provider
  // degrades every subsequent query, and one line at startup is what turns
  // that from invisible into diagnosable (#179).
  const missingKey = checkMissingSearchKey({
    config: options.config,
    env: options.env ?? process.env,
  });
  if (missingKey) {
    const warn =
      options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(missingKey.message);
  }
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
          cooldown,
        });
        return compressToolResult(
          {
            tool: TOOL_NAME,
            status: "ok",
            output: renderNotes(outcome.degraded) + renderResults(outcome.results),
            details: {
              provider: outcome.provider,
              fromCache: outcome.fromCache,
              query: args.query,
              results: outcome.results,
              ...(outcome.degraded.length > 0
                ? { degraded: outcome.degraded }
                : {}),
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

/**
 * Whatever the chain had to skip to answer, printed above the results.
 *
 * In `details` as well, but `details` is structured metadata and this is
 * the half the model reads. The degradation #179 measured was invisible
 * precisely because it was not a failure: the fallback worked, results
 * came back, and nothing anywhere said they came from the weaker
 * provider because the stronger one was out of quota. A model that can
 * see the line can say so in its answer; an operator reading the
 * transcript can act on it.
 */
function renderNotes(degraded: readonly string[]): string {
  if (degraded.length === 0) return "";
  return `${degraded.map((note) => `[search] ${note}`).join("\n")}\n\n`;
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
