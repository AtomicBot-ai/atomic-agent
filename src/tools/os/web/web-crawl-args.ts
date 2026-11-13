/**
 * Arguments, defaults and the text report of `os.web.crawl` (ATO-700).
 */
import type { WebCrawlConfig } from "../../../config/index.js";
import type { ExtractMode } from "./web-fetch-extract.js";

export const CRAWL_TOOL_NAME = "os.web.crawl";

/** Mirrors `createWebCrawlDefaults()` for callers that build the tool without a config. */
export const DEFAULT_CRAWL_CONFIG: WebCrawlConfig = {
  minDelayMs: 1_000,
  maxPages: 50,
  maxDepth: 2,
  respectRobots: true,
  robotsExemptHosts: [],
  cacheTtlMinutes: 15,
};

/** Pages read when the call does not say. Below the config cap on purpose. */
export const DEFAULT_PAGES = 20;
export const DEFAULT_CHARS_PER_PAGE = 6_000;
export const MAX_CHARS_PER_PAGE = 20_000;
/** What the model sees in one result; the rest spills to a file in local mode. */
export const MAX_TOTAL_CHARS = 50_000;
/** Wall-clock budget of one crawl; it stops cleanly and says so. */
export const CRAWL_TIME_BUDGET_MS = 120_000;

export interface CrawlArgs {
  url: string;
  maxPages: number;
  maxDepth: number;
  pathPrefix: string | null;
  useSitemap: boolean;
  mode: ExtractMode;
  maxCharsPerPage: number;
}

function intArg(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export function parseCrawlArgs(raw: Record<string, unknown>, cfg: WebCrawlConfig): CrawlArgs {
  const url = raw.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${CRAWL_TOOL_NAME}: \`url\` must be a non-empty string`);
  }
  let mode: ExtractMode = "markdown";
  const rawMode = raw.extractMode;
  if (rawMode !== undefined) {
    if (rawMode !== "markdown" && rawMode !== "text") {
      throw new Error(`${CRAWL_TOOL_NAME}: \`extractMode\` must be "markdown" or "text"`);
    }
    mode = rawMode;
  }
  let pathPrefix: string | null = null;
  const rawPrefix = raw.pathPrefix;
  if (typeof rawPrefix === "string" && rawPrefix.trim().length > 0) {
    const p = rawPrefix.trim();
    pathPrefix = p.startsWith("/") ? p : `/${p}`;
  }
  return {
    url,
    maxPages: intArg(raw.maxPages, Math.min(DEFAULT_PAGES, cfg.maxPages), 1, cfg.maxPages),
    maxDepth: intArg(raw.maxDepth, cfg.maxDepth, 0, cfg.maxDepth),
    pathPrefix,
    useSitemap: raw.useSitemap !== false,
    mode,
    maxCharsPerPage: intArg(raw.maxCharsPerPage, DEFAULT_CHARS_PER_PAGE, 200, MAX_CHARS_PER_PAGE),
  };
}

export interface CrawledPage {
  url: string;
  title?: string;
  depth: number;
  status: number;
  text: string;
  truncated: boolean;
}

export type StopReason = "done" | "page-limit" | "throttled" | "time-budget" | "aborted" | "errors";

export interface CrawlReport {
  start: string;
  pages: CrawledPage[];
  robotsSource: string;
  blockedByRobots: string[];
  leftUnread: number;
  sitemapPages: number;
  errors: { url: string; message: string }[];
  stoppedBecause: StopReason;
  delayMs: number;
}

const STOP_TEXT: Record<StopReason, string> = {
  done: "",
  "page-limit": "Stopped at the page limit.",
  throttled: "Stopped: the site kept answering 429/503 (slow down).",
  "time-budget": "Stopped at the time budget.",
  aborted: "Stopped: the task was cancelled.",
  errors: "Stopped after repeated errors.",
};

/** The header the model reads first: what was read, what was not, and why. */
export function crawlHeader(r: CrawlReport, maxDepth: number): string {
  const lines = [
    `Crawled ${r.pages.length} page${r.pages.length === 1 ? "" : "s"} from ${r.start} ` +
      `(depth ≤ ${maxDepth}, ${Math.round(r.delayMs / 100) / 10}s between requests, robots.txt: ${r.robotsSource}).`,
  ];
  const notRead: string[] = [];
  if (r.blockedByRobots.length > 0) notRead.push(`${r.blockedByRobots.length} blocked by robots.txt`);
  if (r.leftUnread > 0) notRead.push(`${r.leftUnread} more found but not read`);
  if (r.errors.length > 0) notRead.push(`${r.errors.length} failed`);
  if (notRead.length > 0) lines.push(`Not read: ${notRead.join(", ")}.`);
  if (r.sitemapPages > 0) lines.push(`Sitemap listed ${r.sitemapPages} page(s) in scope.`);
  const stop = STOP_TEXT[r.stoppedBecause];
  if (stop) lines.push(stop);
  for (const e of r.errors.slice(0, 5)) lines.push(`- ${e.url}: ${e.message}`);
  return lines.join("\n");
}

export function pageSection(page: CrawledPage): string {
  const title = page.title?.trim() || page.url;
  return `\n## ${title}\n${page.url}\n\n${page.text}${page.truncated ? "\n… [page truncated]" : ""}\n`;
}
