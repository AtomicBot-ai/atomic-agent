#!/usr/bin/env node
// Polite, read-only SEO crawl of one site. Reads robots.txt and the
// sitemap, fetches a small number of pages with GET, checks the links it
// found with HEAD (GET only when a server refuses HEAD), waits between
// every request and never submits a form. Prints one JSON object.
//
// The crawl runs inside a time budget (--deadline-seconds, 240 by
// default, under the 300 s timeout the skill uses). At 80% of it no new
// request starts and the JSON collected so far is printed with
// `partial: true`, so a slow site or a long Crawl-delay still gives the
// agent a report instead of a killed process with no output.
//
// Usage: node crawl.mjs <site-url> [--max-pages 20] [--max-links 100] [--delay-ms 1000] [--deadline-seconds 240]

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { USER_AGENT, buildFindings, extractPageFacts, isAllowed, parseRobots, parseSitemap } from "./seo-lib.mjs";

export const LIMITS = {
  maxPages: [20, 1, 50],
  maxLinks: [100, 0, 300],
  delayMs: [1000, 500, 10000],
  deadlineSeconds: [240, 30, 3600],
};
const FLAGS = { "--max-pages": "maxPages", "--max-links": "maxLinks", "--delay-ms": "delayMs", "--deadline-seconds": "deadlineSeconds" };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_SITEMAP_DOCS = 5;
const REQUEST_TIMEOUT_MS = 15000;
/** Share of the deadline after which no new request starts. */
export const SOFT_BUDGET_SHARE = 0.8;
const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|dmg|exe)$/i;

export function parseArgs(argv) {
  const opts = { site: null };
  for (const [key, [def]] of Object.entries(LIMITS)) opts[key] = def;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const flag = FLAGS[a];
    if (flag) {
      const [, min, max] = LIMITS[flag];
      const n = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(n)) opts[flag] = Math.min(max, Math.max(min, Math.round(n)));
    } else if (!a.startsWith("--") && opts.site === null) {
      opts.site = a;
    }
  }
  return opts;
}

/** Hard and soft limits in ms. No request starts once the soft one is reached. */
export function budgetFor(deadlineSeconds) {
  const hardMs = deadlineSeconds * 1000;
  return { hardMs, softMs: Math.floor(hardMs * SOFT_BUDGET_SHARE) };
}

/** `example.com` and `www.example.com` are the same site. */
export function siteKey(host) {
  return String(host).toLowerCase().replace(/^www\./, "");
}

export function sameSite(url, host) {
  try { return siteKey(new URL(url).host) === siteKey(host); } catch { return false; }
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

class OutOfTime extends Error {}

const errText = (err) => String(err?.cause?.code ?? err?.name ?? err?.message ?? err);

async function readText(res) {
  if (!res.body) return "";
  if (typeof res.body.getReader !== "function") return String(await res.text());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

const discard = async (res) => { await res.body?.cancel?.().catch(() => {}); };

/**
 * Start a crawl. `deps` lets a test swap the network and the clock:
 * `{ fetch, now, sleep }`. Returns `done` (the final JSON object) and
 * `snapshot(reason)`, which builds the JSON from what was collected so
 * far, for a stop from outside (SIGTERM, Ctrl+C).
 */
export function startCrawl(opts, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const budget = budgetFor(opts.deadlineSeconds ?? LIMITS.deadlineSeconds[0]);
  const st = {
    startedAt: now(),
    lastRequestAt: -Infinity,
    requests: 0,
    delayMs: opts.delayMs ?? LIMITS.delayMs[0],
    partial: null,
    fatal: null,
    site: null,
    host: null,
    sitemap: null,
    pages: [],
    links: [],
    candidates: [],
    redirectedTo: undefined,
  };

  async function politeFetch(url, method = "GET") {
    const wait = Math.max(0, st.lastRequestAt + st.delayMs - now());
    if (now() + wait - st.startedAt >= budget.softMs) {
      st.partial ??= { reason: "time_budget", detail: `stopped at ${Math.round(SOFT_BUDGET_SHARE * 100)}% of the ${budget.hardMs / 1000} s budget; raise --deadline-seconds (and the run timeout) or lower the caps for a full run` };
      throw new OutOfTime();
    }
    if (wait > 0) await sleep(wait);
    st.lastRequestAt = now();
    st.requests += 1;
    const started = now();
    const left = budget.hardMs - (now() - st.startedAt);
    const res = await fetchImpl(url, {
      method,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: method === "GET" ? "text/html,application/xml;q=0.9,*/*;q=0.8" : "*/*" },
      signal: AbortSignal.timeout(Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, left))),
    });
    return { res, ms: now() - started };
  }

  async function loadSitemaps(start, robots) {
    const queue = [...start];
    const seen = new Set();
    const urls = [];
    const errors = [];
    let found = false;
    while (queue.length > 0 && seen.size < MAX_SITEMAP_DOCS) {
      const sm = queue.shift();
      if (seen.has(sm)) continue;
      if (/\.gz($|\?)/i.test(sm)) {
        seen.add(sm);
        errors.push({ url: sm, error: "gzip sitemaps are not read" });
        continue;
      }
      try {
        const { res } = await politeFetch(sm);
        seen.add(sm);
        if (!res.ok) {
          errors.push({ url: sm, status: res.status });
          await discard(res);
          continue;
        }
        const parsed = parseSitemap(await readText(res));
        found = true;
        if (parsed.isIndex) queue.push(...parsed.locs);
        else urls.push(...parsed.locs);
      } catch (err) {
        if (err instanceof OutOfTime) break;
        seen.add(sm);
        errors.push({ url: sm, error: errText(err) });
      }
    }
    const onSite = urls.filter((u) => sameSite(u, st.host));
    return {
      found,
      read: [...seen],
      urlCount: urls.length,
      otherHostUrls: urls.length - onSite.length,
      disallowedByRobots: onSite.filter((u) => !isAllowed(robots, u)).length,
      urls: onSite,
      errors,
    };
  }

  async function run() {
    const base = new URL(/^https?:\/\//i.test(opts.site) ? opts.site : `https://${opts.site}`);
    st.host = base.host;
    let origin = base.origin;

    let robots = { rules: [], crawlDelay: null, sitemaps: [] };
    let robotsStatus = null;
    try {
      const { res } = await politeFetch(`${origin}/robots.txt`);
      robotsStatus = res.status;
      if (res.ok) robots = parseRobots(await readText(res));
      else await discard(res);
      if (res.status >= 500) throw new Error(`robots.txt answered ${res.status}`);
    } catch (err) {
      // An unreachable robots.txt means we cannot know what is allowed: stop.
      st.fatal = { site: origin, userAgent: USER_AGENT, error: "robots_unreachable", detail: errText(err) };
      return;
    }
    if (robots.crawlDelay !== null) st.delayMs = Math.min(LIMITS.delayMs[2], Math.max(st.delayMs, robots.crawlDelay * 1000));
    const robotsBlocksAll = !isAllowed(robots, `${origin}/`);
    st.site = { origin, robotsStatus, robotsBlocksAll, crawlDelaySeconds: robots.crawlDelay, delayMs: st.delayMs, sitemapFound: false };
    if (robotsBlocksAll) return;

    const queue = [base.href];
    const queued = new Set(queue);
    const linkSources = new Map();
    let inSitemap = new Set();

    const crawlPage = async (url) => {
      const page = { url, inSitemap: inSitemap.has(url) };
      try {
        const { res, ms } = await politeFetch(url);
        Object.assign(page, { status: res.status, finalUrl: res.url || url, ms, xRobots: res.headers.get("x-robots-tag") });
        if (page.finalUrl) queued.add(page.finalUrl);
        if (st.pages.length === 0 && page.finalUrl) {
          // The start URL decides the site: `example.com` that redirects
          // to `www.example.com` is crawled as www from here on.
          const finalHost = new URL(page.finalUrl).host;
          if (sameSite(page.finalUrl, st.host)) {
            st.host = finalHost;
            origin = new URL(page.finalUrl).origin;
            st.site.origin = origin;
          } else if (finalHost !== st.host) {
            st.redirectedTo = page.finalUrl;
          }
        }
        const type = res.headers.get("content-type") ?? "";
        if (res.ok && type.includes("html")) {
          page.facts = extractPageFacts(await readText(res), page.finalUrl);
          for (const link of page.facts.links) {
            const sources = linkSources.get(link) ?? [];
            if (sources.length < 5) sources.push(url);
            linkSources.set(link, sources);
            // Without a sitemap, follow internal links to find pages. Only
            // links on the crawled host itself: a link to the www or apex
            // twin is checked later and reported if it redirects.
            if (hostOf(link) === st.host && !queued.has(link) && isAllowed(robots, link) && !SKIP_EXT.test(link)) {
              queued.add(link);
              queue.push(link);
            }
          }
        } else {
          await discard(res);
        }
      } catch (err) {
        if (err instanceof OutOfTime) return false;
        page.error = errText(err);
      }
      st.pages.push(page);
      return true;
    };

    // Home page first, so its redirect fixes the host before the sitemap
    // and the links are sorted into this site and other sites.
    if (!(await crawlPage(queue.shift()))) return;

    const sitemapStart = robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`];
    st.sitemap = await loadSitemaps(sitemapStart, robots);
    st.site.sitemapFound = st.sitemap.found;
    inSitemap = new Set(st.sitemap.urls);
    if (st.pages[0] && inSitemap.has(st.pages[0].url)) st.pages[0].inSitemap = true;
    // Sitemap pages go first, in sitemap order, then the followed links.
    const seenPages = new Set(st.pages.flatMap((p) => [p.url, p.finalUrl].filter(Boolean)));
    const fromSitemap = [...new Set(st.sitemap.urls.filter((u) => isAllowed(robots, u) && !seenPages.has(u)))];
    const front = new Set(fromSitemap);
    const rest = queue.filter((u) => !front.has(u));
    queue.length = 0;
    queue.push(...fromSitemap, ...rest);
    for (const u of fromSitemap) queued.add(u);

    while (queue.length > 0 && st.pages.length < opts.maxPages && st.partial === null) {
      if (!(await crawlPage(queue.shift()))) break;
    }

    const crawled = new Set(st.pages.flatMap((p) => [p.url, p.finalUrl].filter(Boolean)));
    st.candidates = [...linkSources.keys()].filter((u) => !crawled.has(u));
    const isInternal = (u) => sameSite(u, st.host);
    st.candidates.sort((a, b) => Number(isInternal(b)) - Number(isInternal(a)));
    for (const url of st.candidates.slice(0, opts.maxLinks)) {
      if (st.partial !== null) break;
      const internal = isInternal(url);
      const link = { url, internal, foundOn: linkSources.get(url) };
      if (internal && !isAllowed(robots, url)) {
        link.skipped = "robots";
        st.links.push(link);
        continue;
      }
      try {
        let { res } = await politeFetch(url, "HEAD");
        if ([403, 405, 501].includes(res.status)) {
          await discard(res);
          ({ res } = await politeFetch(url, "GET"));
        }
        await discard(res);
        Object.assign(link, { status: res.status, redirected: res.redirected, finalUrl: res.url });
      } catch (err) {
        if (err instanceof OutOfTime) break;
        link.error = errText(err);
      }
      st.links.push(link);
    }
  }

  const done = run().then(
    () => snapshot(null),
    (err) => ({ error: "crawl_failed", detail: errText(err), ...partialOf(st) }),
  );

  function snapshot(stopReason) {
    if (st.fatal) return st.fatal;
    if (stopReason && st.partial === null) st.partial = { reason: stopReason, detail: "the crawl was stopped before it finished" };
    if (st.site === null) return { error: "crawl_failed", detail: "stopped before robots.txt was read", ...partialOf(st) };
    return buildReport(st, opts, now() - st.startedAt);
  }

  return { done, snapshot };
}

const partialOf = (st) => (st.partial ? { partial: true, partialReason: st.partial.reason, partialDetail: st.partial.detail } : {});

function buildReport(st, opts, elapsedMs) {
  const { site, pages, links } = st;
  const sitemap = st.sitemap ?? { found: false, read: [], urlCount: 0, otherHostUrls: 0, disallowedByRobots: 0, urls: [], errors: [] };
  const brokenOrRedirect = (l) => l.error || (l.status ?? 0) >= 400 || l.redirected;
  return {
    site: st.redirectedTo ? { ...site, redirectedTo: st.redirectedTo } : site,
    userAgent: USER_AGENT,
    ...partialOf(st),
    requests: st.requests,
    elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    sitemap: { ...sitemap, urls: undefined, sampleUrls: sitemap.urls.slice(0, 5) },
    limits: {
      maxPages: opts.maxPages,
      maxLinks: opts.maxLinks,
      deadlineSeconds: opts.deadlineSeconds,
      pagesCrawled: pages.length,
      htmlPages: pages.filter((p) => p.facts).length,
      linksFound: st.candidates.length,
      linksChecked: links.length,
    },
    findings: buildFindings({ pages, links, site }),
    pages: pages.map((p) => ({
      url: p.url,
      status: p.status ?? null,
      error: p.error,
      finalUrl: p.finalUrl !== p.url ? p.finalUrl : undefined,
      ms: p.ms,
      inSitemap: p.inSitemap,
      title: p.facts?.titles[0],
      descriptionLength: p.facts?.description?.length ?? null,
      h1Count: p.facts?.h1s.length,
      canonical: p.facts?.canonical,
      jsonLdTypes: p.facts?.jsonLd.types,
    })),
    linkProblems: links.filter(brokenOrRedirect),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.site) {
    console.log(JSON.stringify({ error: "usage: crawl.mjs <site-url> [--max-pages N] [--max-links N] [--delay-ms N] [--deadline-seconds N]" }));
    process.exitCode = 2;
    return;
  }
  const crawl = startCrawl(opts);
  let printed = false;
  const print = (obj, exitNow) => {
    if (printed) return;
    printed = true;
    const code = obj.error && !obj.partial ? 1 : 0;
    // Exit only after the write has flushed: stdout to a pipe is async.
    process.stdout.write(JSON.stringify(obj) + "\n", () => {
      if (exitNow) process.exit(code);
    });
    if (!exitNow) process.exitCode = code;
  };
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => print(crawl.snapshot(`stopped_by_${sig}`), true));
  print(await crawl.done, false);
}

const invokedDirectly = (() => {
  try { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.log(JSON.stringify({ error: "crawl_failed", detail: errText(err) }));
    process.exitCode = 1;
  });
}
