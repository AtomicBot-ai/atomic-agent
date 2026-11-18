/**
 * The crawl loop of `os.web.crawl` (ATO-700): breadth first from the start
 * page, sitemap pages after the start page's own links, every URL checked
 * against scope and robots.txt before it is fetched. The network goes
 * through the caller's `fetchPage`, which carries the pace and the cache.
 */
import { CurlUnavailableError } from "./ensure-curl.js";
import { describeJsPages, looksJsRendered } from "./crawl-js-page.js";
import { extractPageLinks, inCrawlScope, normaliseCrawlUrl, parseSitemap } from "./crawl-links.js";
import type { CrawlPoliteness, RobotsDecision } from "./crawl-politeness.js";
import { startMoveAllowed } from "./crawl-scope.js";
import { decodeSitemapBody } from "./sitemap-body.js";
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
/** Times the start page may move the crawl to a new origin; os.web.fetch's own redirect cap. */
export const MAX_START_MOVES = 3;
/** JS-built pages rendered in the agent's browser per crawl; a browser load costs far more than curl. */
export const MAX_BROWSER_RENDERS = 5;

/**
 * The site being crawled. Mutable: when the start page redirects within the
 * same site (`example.com` -> `www.example.com`) the crawl moves with it, and
 * the caller's fetcher reads the new origin from here.
 */
export interface CrawlScope {
  start: URL;
  robots: RobotsDecision;
}

export interface RenderedCrawlPage {
  finalUrl: string;
  title: string;
  html: string;
}

export interface RunCrawlInput {
  args: CrawlArgs;
  scope: CrawlScope;
  politeness: CrawlPoliteness;
  signal: AbortSignal;
  now: () => number;
  deadline: number;
  /** `binary` keeps the body as bytes (sitemaps, which may be gzipped). */
  fetchPage: (url: string, opts?: { binary?: boolean }) => Promise<FetchOutcome>;
  /** robots.txt of a new origin the start page moved to. */
  robotsFor: (url: URL) => Promise<RobotsDecision>;
  /**
   * Render a JS-built page in the agent's own browser (paced, SSRF-checked
   * by the caller). Absent, or resolving null, the page is listed as one
   * that needs the browser.
   */
  renderPage?: (url: string) => Promise<RenderedCrawlPage | null>;
}

interface QueueItem {
  url: string;
  depth: number;
}

export async function runCrawl(input: RunCrawlInput): Promise<CrawlReport> {
  const { args, scope, politeness } = input;
  const queue: QueueItem[] = [];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  const blockedByRobots: string[] = [];
  const errors: { url: string; message: string }[] = [];
  const notes: string[] = [];
  const jsPages: string[] = [];
  let rendered = 0;
  let startMoves = 0;
  let startSettled = false;
  let overflow = 0;
  let sitemapPages = 0;
  let sitemapLoaded = !args.useSitemap || args.maxDepth < 1;
  let consecutiveErrors = 0;
  let stoppedBecause: StopReason = "done";

  const block = (key: string): void => {
    if (!blockedByRobots.includes(key)) blockedByRobots.push(key);
  };

  const enqueue = (url: URL, depth: number): boolean => {
    if (!inCrawlScope(url, scope.start, args.pathPrefix)) return false;
    const key = normaliseCrawlUrl(url);
    if (seen.has(key)) return false;
    seen.add(key);
    if (!politeness.allows(scope.robots, url)) {
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
  const startKey = normaliseCrawlUrl(scope.start);
  seen.add(startKey);
  queue.push({ url: startKey, depth: 0 });

  /**
   * The start page redirected to another origin. Within the same site the
   * crawl moves there (new scope, its robots.txt, the page queued again);
   * to another site it stops and says where the page went. Like Crawlee,
   * which scopes links by the page's loaded URL after redirects.
   */
  const moveStart = async (from: string, target: URL): Promise<boolean> => {
    startMoves++;
    const verdict = startMoveAllowed(scope.start, target);
    if (!verdict.ok || startMoves > MAX_START_MOVES) {
      const why = verdict.ok ? "it kept redirecting" : verdict.reason;
      notes.push(
        `The start page ${from} was not followed: ${why}. A crawl stays on one site; ` +
          `crawl ${target.toString()} directly if that is the site meant.`,
      );
      stoppedBecause = "start-moved";
      return false;
    }
    const robots = target.origin === scope.start.origin ? scope.robots : await input.robotsFor(target);
    if (!politeness.allows(robots, target)) {
      notes.push(`The start page ${from} redirects to ${target.toString()}, which robots.txt of ${target.host} does not allow.`);
      block(normaliseCrawlUrl(target));
      stoppedBecause = "start-moved";
      return false;
    }
    notes.push(`The start page ${from} redirects to ${target.toString()}; crawled ${target.host} instead.`);
    scope.start = target;
    scope.robots = robots;
    politeness.pacer.resetStrikes(target.host);
    const key = normaliseCrawlUrl(target);
    seen.add(key);
    queue.unshift({ url: key, depth: 0 });
    return true;
  };

  while (queue.length > 0) {
    if (input.signal.aborted) { stoppedBecause = "aborted"; break; }
    if (pages.length >= args.maxPages) { stoppedBecause = "page-limit"; break; }
    if (input.now() >= input.deadline) { stoppedBecause = "time-budget"; break; }
    if (politeness.pacer.isThrottled(scope.start.host)) { stoppedBecause = "throttled"; break; }
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { stoppedBecause = "errors"; break; }

    const item = queue.shift()!;
    const isStart = !startSettled;
    let res: FetchOutcome;
    try {
      res = await input.fetchPage(item.url);
    } catch (err) {
      if (err instanceof CurlUnavailableError) throw err;
      startSettled = true;
      errors.push({ url: item.url, message: (err as Error).message });
      consecutiveErrors++;
      continue;
    }

    // An off-site hop is refused before it is requested (the caller's
    // fetcher); `finalUrl` off the origin is the backstop for one that was not.
    const offSite =
      res.refusedRedirect !== undefined
        ? new URL(res.refusedRedirect)
        : new URL(res.finalUrl).origin !== scope.start.origin
          ? new URL(res.finalUrl)
          : null;
    if (offSite !== null && offSite.origin === scope.start.origin) {
      // A same-site redirect into a robots.txt-disallowed path: not requested.
      startSettled = true;
      block(normaliseCrawlUrl(offSite));
      continue;
    }
    if (offSite !== null) {
      if (isStart) {
        if (await moveStart(item.url, offSite)) continue;
        break;
      }
      errors.push({ url: item.url, message: `redirected off the site to ${offSite.origin}; not followed` });
      continue;
    }
    startSettled = true;
    const finalUrl = new URL(res.finalUrl);
    const finalKey = normaliseCrawlUrl(finalUrl);
    seen.add(finalKey);
    // Backstop for a redirect that ended on a disallowed path anyway (e.g. a
    // fetcher without the per-hop check): the page is dropped, not returned.
    if (finalKey !== item.url && !politeness.allows(scope.robots, finalUrl)) {
      block(finalKey);
      continue;
    }
    if (res.status === 429 || res.status === 503) politeness.pacer.notePageThrottled(scope.start.host);
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

    let page = { body: res.body, contentType: res.contentType, truncated: res.truncated };
    let extracted = extractWebContent({
      body: page.body,
      contentType: page.contentType,
      url: res.finalUrl,
      mode: args.mode,
    });
    let via: "curl" | "browser" = "curl";
    if (looksJsRendered(res.body, res.contentType, extracted.text)) {
      const browserPage = rendered < MAX_BROWSER_RENDERS ? await renderInBrowser(input, res.finalUrl) : null;
      if (browserPage !== null) {
        rendered++;
        via = "browser";
        page = { body: browserPage.html, contentType: "text/html", truncated: false };
        extracted = extractWebContent({ body: page.body, contentType: page.contentType, url: res.finalUrl, mode: args.mode });
        if (!extracted.title && browserPage.title) extracted = { ...extracted, title: browserPage.title };
      } else {
        jsPages.push(res.finalUrl);
      }
    }
    const truncated = page.truncated || extracted.text.length > args.maxCharsPerPage;
    pages.push({
      url: res.finalUrl,
      title: extracted.title,
      depth: item.depth,
      status: res.status,
      text: extracted.text.slice(0, args.maxCharsPerPage),
      truncated,
      ...(via === "browser" ? { via } : {}),
    });

    if (item.depth < args.maxDepth) {
      for (const link of extractPageLinks(page.body, page.contentType, finalUrl).links) {
        enqueue(link, item.depth + 1);
      }
    }
    if (!sitemapLoaded) {
      sitemapLoaded = true;
      sitemapPages = await loadSitemap(input, (url) => enqueue(url, 1), notes);
    }
  }
  if (rendered > 0) notes.push(`${rendered} page(s) built by JavaScript were rendered in the agent's own browser.`);
  if (jsPages.length > 0) notes.push(describeJsPages(jsPages));

  // An unexplored queue at the end means one of the stop reasons fired.
  if (stoppedBecause === "done" && queue.length > 0) stoppedBecause = "page-limit";
  return {
    start: normaliseCrawlUrl(scope.start),
    pages,
    robotsSource: scope.robots.source,
    blockedByRobots,
    leftUnread: queue.length + overflow,
    sitemapPages,
    errors,
    stoppedBecause,
    delayMs: politeness.pacer.hostDelay(scope.start.host),
    notes,
    jsPages,
  };
}

/**
 * The browser render of a JS-built page, kept only when it landed on an
 * allowed page of the crawled site. A failed render is a miss, not an error:
 * the curl text is still returned and the page is listed as needing the browser.
 */
async function renderInBrowser(input: RunCrawlInput, url: string): Promise<RenderedCrawlPage | null> {
  if (input.renderPage === undefined || input.signal.aborted) return null;
  let page: RenderedCrawlPage | null;
  try {
    page = await input.renderPage(url);
  } catch {
    return null;
  }
  if (page === null) return null;
  let landed: URL;
  try {
    landed = new URL(page.finalUrl);
  } catch {
    return null;
  }
  if (landed.origin !== input.scope.start.origin) return null;
  if (!input.politeness.allows(input.scope.robots, landed)) return null;
  return page;
}

/**
 * Read the sitemap(s) named in robots.txt, else `/sitemap.xml`, following
 * one level of sitemap index, and queue the in-scope pages. Gzipped
 * sitemaps (`.xml.gz`, a gzip Content-Type or Content-Encoding) are
 * unzipped with a size cap. Returns how many
 * were queued. Failures are quiet: a site without a sitemap is normal.
 */
async function loadSitemap(
  input: RunCrawlInput,
  add: (url: URL) => boolean,
  notes: string[],
): Promise<number> {
  const { scope } = input;
  const listed = scope.robots.policy.sitemaps;
  const pending = listed.length > 0 ? [...listed] : [`${scope.start.origin}/sitemap.xml`];
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
    if (sitemapUrl.origin !== scope.start.origin) continue;
    if (!input.politeness.allows(scope.robots, sitemapUrl)) continue;
    files++;
    let res: FetchOutcome;
    try {
      // As bytes: `.xml.gz` and gzip-typed sitemaps are unzipped here (ATO-970).
      res = await input.fetchPage(sitemapUrl.toString(), { binary: true });
    } catch {
      continue;
    }
    if (res.status < 200 || res.status >= 300) continue;
    const text = decodeSitemapBody({ ...(res.bodyBytes ? { bytes: res.bodyBytes } : {}), body: res.body });
    if (!text.ok) {
      notes.push(`Sitemap ${sitemapUrl.toString()}: ${text.reason}.`);
      continue;
    }
    const entries = parseSitemap(text.xml);
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
