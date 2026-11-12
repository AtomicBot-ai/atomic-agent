/**
 * `os.web.crawl` (ATO-700): read a site, not one page. Built on the
 * `os.web.fetch` pipeline (`fetchRawPage`: SSRF guard on every hop, the same
 * redirect and retry rules) and the politeness layer (ATO-970): one request
 * per host per `web.crawl.minDelayMs`, backoff on 429/503 and
 * `Retry-After`, robots.txt, a short cache. Pages come from the start page's
 * same-origin links (breadth first, up to `maxDepth`) and the sitemap.
 */
import { compressToolResult } from "../../../compressor/result-compressor.js";
import { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { CurlUnavailableError } from "./ensure-curl.js";
import { CrawlPoliteness, TtlCache, type Sleep } from "./crawl-politeness.js";
import { fetchRawPage, type FetchOutcome } from "./web-fetch.js";
import { assertHostAllowed, parseHttpUrl, SsrfBlockedError, type HostLookup } from "./web-fetch-ssrf-guard.js";
import {
  CRAWL_TIME_BUDGET_MS,
  CRAWL_TOOL_NAME,
  DEFAULT_CRAWL_CONFIG,
  MAX_TOTAL_CHARS,
  crawlHeader,
  pageSection,
  parseCrawlArgs,
  type CrawlArgs,
  type CrawlReport,
} from "./web-crawl-args.js";
import { runCrawl } from "./web-crawl-run.js";

export interface OsWebCrawlOptions {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  config?: Pick<AtomicAgentConfig, "web">;
  sleep?: Sleep;
  now?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function buildOsWebCrawlTool(options: OsWebCrawlOptions = {}): ToolDefinition {
  const crawlCfg = options.config?.web.crawl ?? DEFAULT_CRAWL_CONFIG;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  // One pace, robots cache and page cache per tool instance, so two crawls
  // of one site in a row neither double the load nor re-read robots.txt.
  const politeness = new CrawlPoliteness({ config: crawlCfg, sleep, now });
  const pageCache = new TtlCache<FetchOutcome>(crawlCfg.cacheTtlMinutes * 60_000, 300, now);

  return {
    name: CRAWL_TOOL_NAME,
    description:
      "Read several pages of one website: follows same-site links from the start URL " +
      "(breadth first, up to `maxDepth`) and the site's sitemap.xml, and returns each " +
      "page as markdown/text. Polite by design: at most one request per second per " +
      "site (longer if robots.txt asks), backs off on 429/503 and Retry-After, obeys " +
      "robots.txt (the user can exempt their own sites in config), caches pages for " +
      "a few minutes. Same SSRF guard and no-JavaScript fetch as os.web.fetch. " +
      "`pathPrefix` keeps it under one section (e.g. \"/docs/\"). For a single page " +
      "use os.web.fetch.",
    readonly: true,
    untrustedOutput: "web pages",
    async run(rawArgs, ctx) {
      const args = parseCrawlArgs(rawArgs, crawlCfg);
      let start: URL;
      try {
        start = parseHttpUrl(args.url);
        // Fail on a private address here, not later as "robots.txt unreachable".
        await assertHostAllowed(start, { lookup: options.lookup });
      } catch (err) {
        return errorResult(args, (err as Error).message, err instanceof SsrfBlockedError);
      }

      const fetchPage = (url: string): Promise<FetchOutcome> =>
        fetchRawPage(url, {
          cwd: ctx.workingDir,
          signal: ctx.signal,
          runCommand: options.runCommand,
          lookup: options.lookup,
          config: options.config,
          sleep,
          hooks: {
            beforeRequest: (u, signal) => politeness.pacer.acquire(u.host, signal),
            afterResponse: (u, status, retryAfterMs) =>
              politeness.pacer.noteResponse(u.host, status, retryAfterMs),
          },
        });

      // A missing curl or a cancelled task is not "robots.txt unreachable".
      let fatal = null as Error | null;
      const robots = await politeness.robotsFor(start, async (robotsUrl) => {
        try {
          const res = await fetchPage(robotsUrl);
          return { status: res.status, body: res.body };
        } catch (err) {
          if (err instanceof CurlUnavailableError || ctx.signal.aborted) fatal = err as Error;
          throw err;
        }
      });
      if (fatal !== null) return errorResult(args, (fatal as Error).message, false);
      if (!politeness.allows(robots, start)) {
        const why =
          robots.source === "unreachable"
            ? `robots.txt of ${start.host} could not be read (server error or no answer), so the site is not crawled`
            : `robots.txt of ${start.host} does not allow ${start.pathname}`;
        return errorResult(
          args,
          `${why}. If this is the user's own site, they can add "${start.hostname}" to web.crawl.robotsExemptHosts.`,
          false,
          { robots: robots.source },
        );
      }

      const report = await runCrawl({
        args,
        start,
        robots,
        politeness,
        signal: ctx.signal,
        now,
        deadline: now() + CRAWL_TIME_BUDGET_MS,
        fetchPage: async (url) => {
          const cached = pageCache.get(url);
          if (cached !== undefined) return cached;
          const res = await fetchPage(url);
          if (res.status >= 200 && res.status < 400) pageCache.set(url, res);
          return res;
        },
      });
      return resultFor(args, report, ctx.modelMode);
    },
  };
}

function errorResult(
  args: CrawlArgs,
  message: string,
  blocked: boolean,
  extra: Record<string, unknown> = {},
): ReturnType<typeof compressToolResult> {
  return compressToolResult({
    tool: CRAWL_TOOL_NAME,
    status: "error",
    output: message,
    details: { url: args.url, blocked, ...extra },
  });
}

function resultFor(
  args: CrawlArgs,
  report: CrawlReport,
  modelMode: "local" | "cloud" | undefined,
): ReturnType<typeof compressToolResult> {
  const header = crawlHeader(report, args.maxDepth);
  const full = header + report.pages.map(pageSection).join("");
  const capped = full.length > MAX_TOTAL_CHARS;
  // As in os.web.fetch (ATO-913): locally the compressor gets the whole
  // text, so the registry's spill keeps it in a file and names the path;
  // cloud mode gets the cut text.
  const output = capped && modelMode === "cloud" ? `${full.slice(0, MAX_TOTAL_CHARS)}\n… [truncated]` : full;
  return compressToolResult(
    {
      tool: CRAWL_TOOL_NAME,
      status: report.pages.length > 0 ? "ok" : "error",
      output,
      details: {
        url: args.url,
        pages: report.pages.map((p) => ({
          url: p.url,
          title: p.title,
          depth: p.depth,
          status: p.status,
          chars: p.text.length,
          truncated: p.truncated,
        })),
        robots: report.robotsSource,
        blockedByRobots: report.blockedByRobots.slice(0, 20),
        leftUnread: report.leftUnread,
        sitemapPages: report.sitemapPages,
        errors: report.errors.slice(0, 10),
        stoppedBecause: report.stoppedBecause,
        delayMs: report.delayMs,
        truncated: capped,
      },
    },
    { maxSummaryLength: MAX_TOTAL_CHARS, maxTailLines: Number.MAX_SAFE_INTEGER },
  );
}
