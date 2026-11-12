/**
 * The crawl loop of `os.web.crawl` (ATO-700): breadth first from the start
 * page, sitemap pages after the start page's own links, every URL checked
 * against scope and robots.txt before it is fetched. The network goes
 * through the caller's `fetchPage`, which carries the pace and the cache.
 */
import { CurlUnavailableError } from "./ensure-curl.js";
import { extractPageLinks, inCrawlScope, normaliseCrawlUrl, parseSitemap } from "./crawl-links.js";
import type { CrawlPoliteness, RobotsDecision } from "./crawl-politeness.js";
import { detectChallenge } from "./web-fetch-challenge.js";
import { extractWebContent } from "./web-fetch-extract.js";
import type { FetchOutcome } from "./web-fetch.js";
import type { CrawlArgs, CrawlReport, CrawledPage, StopReason } from "./web-crawl-args.js";

/** Sitemap files read per crawl (an index and its first children). */
export const MAX_SITEMAP_FILES = 3;
/** URLs held in the queue; past this, found links are only counted. */
export const MAX_QUEUE = 2_000;
/** Failures in a row after which the crawl stops instead of burning the budget. */
export const MAX_CONSECUTIVE_ERRORS = 5;

export interface RunCrawlInput {
  args: CrawlArgs;
  start: URL;
  robots: RobotsDecision;
  politeness: CrawlPoliteness;
  signal: AbortSignal;
  now: () => number;
  deadline: number;
  fetchPage: (url: string) => Promise<FetchOutcome>;
}

interface QueueItem {
  url: string;
  depth: number;
}

export async function runCrawl(input: RunCrawlInput): Promise<CrawlReport> {
  const { args, start, robots, politeness } = input;
  const queue: QueueItem[] = [];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  const blockedByRobots: string[] = [];
  const errors: { url: string; message: string }[] = [];
  let overflow = 0;
  let sitemapPages = 0;
  let sitemapLoaded = !args.useSitemap || args.maxDepth < 1;
  let consecutiveErrors = 0;
  let stoppedBecause: StopReason = "done";

  const enqueue = (url: URL, depth: number): boolean => {
    if (!inCrawlScope(url, start, args.pathPrefix)) return false;
    const key = normaliseCrawlUrl(url);
    if (seen.has(key)) return false;
    seen.add(key);
    if (!politeness.allows(robots, url)) {
      blockedByRobots.push(key);
      return false;
    }
    if (queue.length >= MAX_QUEUE) {
      overflow++;
      return false;
    }
    queue.push({ url: key, depth });
    return true;
  };

  // The start page is checked against robots.txt by the caller; it may sit
  // outside `pathPrefix` (a docs index linking into /docs/), so it is queued
  // directly rather than through the scope filter.
  const startKey = normaliseCrawlUrl(start);
  seen.add(startKey);
  queue.push({ url: startKey, depth: 0 });

  while (queue.length > 0) {
    if (input.signal.aborted) { stoppedBecause = "aborted"; break; }
    if (pages.length >= args.maxPages) { stoppedBecause = "page-limit"; break; }
    if (input.now() >= input.deadline) { stoppedBecause = "time-budget"; break; }
    if (politeness.pacer.isThrottled(start.host)) { stoppedBecause = "throttled"; break; }
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { stoppedBecause = "errors"; break; }

    const item = queue.shift()!;
    let res: FetchOutcome;
    try {
      res = await input.fetchPage(item.url);
    } catch (err) {
      if (err instanceof CurlUnavailableError) throw err;
      errors.push({ url: item.url, message: (err as Error).message });
      consecutiveErrors++;
      continue;
    }

    const finalUrl = new URL(res.finalUrl);
    seen.add(normaliseCrawlUrl(finalUrl));
    if (finalUrl.origin !== start.origin) {
      // Usually example.com -> www.example.com on the start page: the model
      // can crawl again from where the site sent it.
      const hint = item.depth === 0 ? `; crawl again from ${res.finalUrl}` : "";
      errors.push({ url: item.url, message: `redirected off the site to ${finalUrl.origin}${hint}` });
      continue;
    }
    const challenge = detectChallenge({ status: res.status, contentType: res.contentType, body: res.body });
    if (challenge.challenged) {
      errors.push({ url: item.url, message: `bot-protection challenge (HTTP ${res.status})` });
      consecutiveErrors++;
      continue;
    }
    if (res.status >= 400 || res.status === 0) {
      errors.push({ url: item.url, message: `HTTP ${res.status}` });
      consecutiveErrors++;
      continue;
    }
    consecutiveErrors = 0;

    const extracted = extractWebContent({
      body: res.body,
      contentType: res.contentType,
      url: res.finalUrl,
      mode: args.mode,
    });
    const truncated = res.truncated || extracted.text.length > args.maxCharsPerPage;
    pages.push({
      url: res.finalUrl,
      title: extracted.title,
      depth: item.depth,
      status: res.status,
      text: extracted.text.slice(0, args.maxCharsPerPage),
      truncated,
    });

    if (item.depth < args.maxDepth) {
      for (const link of extractPageLinks(res.body, res.contentType, finalUrl).links) {
        enqueue(link, item.depth + 1);
      }
    }
    if (!sitemapLoaded) {
      sitemapLoaded = true;
      sitemapPages = await loadSitemap(input, (url) => enqueue(url, 1));
    }
  }

  // An unexplored queue at the end means one of the stop reasons fired.
  if (stoppedBecause === "done" && queue.length > 0) stoppedBecause = "page-limit";
  return {
    start: startKey,
    pages,
    robotsSource: input.robots.source,
    blockedByRobots,
    leftUnread: queue.length + overflow,
    sitemapPages,
    errors,
    stoppedBecause,
    delayMs: politeness.pacer.hostDelay(start.host),
  };
}

/**
 * Read the sitemap(s) named in robots.txt, else `/sitemap.xml`, following
 * one level of sitemap index, and queue the in-scope pages. Returns how many
 * were queued. Failures are quiet: a site without a sitemap is normal.
 */
async function loadSitemap(input: RunCrawlInput, add: (url: URL) => boolean): Promise<number> {
  const listed = input.robots.policy.sitemaps;
  const pending = listed.length > 0 ? [...listed] : [`${input.start.origin}/sitemap.xml`];
  let files = 0;
  let queued = 0;
  while (pending.length > 0 && files < MAX_SITEMAP_FILES && !input.signal.aborted) {
    const next = pending.shift()!;
    let sitemapUrl: URL;
    try {
      sitemapUrl = new URL(next);
    } catch {
      continue;
    }
    // Sitemaps on another host are not fetched: the crawl stays on one site.
    if (sitemapUrl.origin !== input.start.origin) continue;
    if (!input.politeness.allows(input.robots, sitemapUrl)) continue;
    files++;
    let res: FetchOutcome;
    try {
      res = await input.fetchPage(sitemapUrl.toString());
    } catch {
      continue;
    }
    if (res.status < 200 || res.status >= 300) continue;
    const entries = parseSitemap(res.body);
    pending.push(...entries.sitemaps);
    for (const page of entries.pages) {
      try {
        if (add(new URL(page))) queued++;
      } catch {
        // A malformed <loc> is skipped.
      }
    }
  }
  return queued;
}
