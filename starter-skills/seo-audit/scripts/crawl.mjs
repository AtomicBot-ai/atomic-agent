#!/usr/bin/env node
// Polite, read-only SEO crawl of one site. Reads robots.txt and the
// sitemap, fetches a small number of pages with GET, checks the links it
// found with HEAD (GET only when a server refuses HEAD), waits between
// every request and never submits a form. Prints one JSON object.
//
// Usage: node crawl.mjs <site-url> [--max-pages 20] [--max-links 100] [--delay-ms 1000]

import { USER_AGENT, buildFindings, extractPageFacts, isAllowed, parseRobots, parseSitemap } from "./seo-lib.mjs";

const LIMITS = { maxPages: [20, 1, 50], maxLinks: [100, 0, 300], delayMs: [1000, 500, 10000] };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_SITEMAP_DOCS = 5;
const REQUEST_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const opts = { site: null };
  for (const [key, [def]] of Object.entries(LIMITS)) opts[key] = def;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const flag = { "--max-pages": "maxPages", "--max-links": "maxLinks", "--delay-ms": "delayMs" }[a];
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let requestCount = 0;
let delayMs = LIMITS.delayMs[0];

async function politeFetch(url, method = "GET") {
  const wait = lastRequestAt + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  requestCount += 1;
  const started = Date.now();
  const res = await fetch(url, {
    method,
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: method === "GET" ? "text/html,application/xml;q=0.9,*/*;q=0.8" : "*/*" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { res, ms: Date.now() - started };
}

async function readText(res) {
  if (!res.body) return "";
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

const errText = (err) => String(err?.cause?.code ?? err?.name ?? err?.message ?? err);

async function loadSitemaps(start, host, robots) {
  const queue = [...start];
  const seen = new Set();
  const urls = [];
  const errors = [];
  let found = false;
  while (queue.length > 0 && seen.size < MAX_SITEMAP_DOCS) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    if (/\.gz($|\?)/i.test(sm)) {
      errors.push({ url: sm, error: "gzip sitemaps are not read" });
      continue;
    }
    try {
      const { res } = await politeFetch(sm);
      if (!res.ok) {
        errors.push({ url: sm, status: res.status });
        await res.body?.cancel();
        continue;
      }
      const parsed = parseSitemap(await readText(res));
      found = true;
      if (parsed.isIndex) queue.push(...parsed.locs);
      else urls.push(...parsed.locs);
    } catch (err) {
      errors.push({ url: sm, error: errText(err) });
    }
  }
  const sameHost = urls.filter((u) => { try { return new URL(u).host === host; } catch { return false; } });
  return {
    found,
    read: [...seen],
    urlCount: urls.length,
    otherHostUrls: urls.length - sameHost.length,
    disallowedByRobots: sameHost.filter((u) => !isAllowed(robots, u)).length,
    urls: sameHost,
    errors,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.site) {
    console.log(JSON.stringify({ error: "usage: crawl.mjs <site-url> [--max-pages N] [--max-links N] [--delay-ms N]" }));
    process.exitCode = 2;
    return;
  }
  const base = new URL(/^https?:\/\//i.test(opts.site) ? opts.site : `https://${opts.site}`);
  const origin = base.origin;
  const host = base.host;
  delayMs = opts.delayMs;

  let robots = { rules: [], crawlDelay: null, sitemaps: [] };
  let robotsStatus = null;
  try {
    const { res } = await politeFetch(`${origin}/robots.txt`);
    robotsStatus = res.status;
    if (res.ok) robots = parseRobots(await readText(res));
    else await res.body?.cancel();
    if (res.status >= 500) throw new Error(`robots.txt answered ${res.status}`);
  } catch (err) {
    // An unreachable robots.txt means we cannot know what is allowed: stop.
    console.log(JSON.stringify({ site: origin, userAgent: USER_AGENT, error: "robots_unreachable", detail: errText(err) }));
    process.exitCode = 1;
    return;
  }
  if (robots.crawlDelay !== null) delayMs = Math.min(LIMITS.delayMs[2], Math.max(delayMs, robots.crawlDelay * 1000));
  const robotsBlocksAll = !isAllowed(robots, `${origin}/`);

  const site = { origin, robotsStatus, robotsBlocksAll, crawlDelaySeconds: robots.crawlDelay, delayMs, sitemapFound: false };
  if (robotsBlocksAll) {
    console.log(JSON.stringify({ site, userAgent: USER_AGENT, findings: buildFindings({ pages: [], site }), pages: [], links: [] }));
    return;
  }

  const sitemapStart = robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const sitemap = await loadSitemaps(sitemapStart, host, robots);
  site.sitemapFound = sitemap.found;
  const inSitemap = new Set(sitemap.urls);

  const queue = [...new Set([base.href, ...sitemap.urls.filter((u) => isAllowed(robots, u))])];
  const queued = new Set(queue);
  const pages = [];
  const linkSources = new Map();
  while (queue.length > 0 && pages.length < opts.maxPages) {
    const url = queue.shift();
    const page = { url, inSitemap: inSitemap.has(url) };
    try {
      const { res, ms } = await politeFetch(url);
      Object.assign(page, { status: res.status, finalUrl: res.url, ms, xRobots: res.headers.get("x-robots-tag") });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.includes("html")) {
        page.facts = extractPageFacts(await readText(res), res.url);
        for (const link of page.facts.links) {
          const sources = linkSources.get(link) ?? [];
          if (sources.length < 5) sources.push(url);
          linkSources.set(link, sources);
          let internal = false;
          try { internal = new URL(link).host === host; } catch { /* skip */ }
          // Without a sitemap, follow internal links to find pages.
          if (internal && !queued.has(link) && isAllowed(robots, link) && !/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|dmg|exe)$/i.test(link)) {
            queued.add(link);
            queue.push(link);
          }
        }
      } else {
        await res.body?.cancel();
      }
    } catch (err) {
      page.error = errText(err);
    }
    pages.push(page);
  }

  const crawled = new Set(pages.flatMap((p) => [p.url, p.finalUrl].filter(Boolean)));
  const candidates = [...linkSources.keys()].filter((u) => !crawled.has(u));
  const isInternal = (u) => { try { return new URL(u).host === host; } catch { return false; } };
  candidates.sort((a, b) => Number(isInternal(b)) - Number(isInternal(a)));
  const links = [];
  for (const url of candidates.slice(0, opts.maxLinks)) {
    const internal = isInternal(url);
    const link = { url, internal, foundOn: linkSources.get(url) };
    if (internal && !isAllowed(robots, url)) {
      link.skipped = "robots";
      links.push(link);
      continue;
    }
    try {
      let { res } = await politeFetch(url, "HEAD");
      if ([403, 405, 501].includes(res.status)) ({ res } = await politeFetch(url, "GET"));
      await res.body?.cancel();
      Object.assign(link, { status: res.status, redirected: res.redirected, finalUrl: res.url });
    } catch (err) {
      link.error = errText(err);
    }
    links.push(link);
  }
  const internalPagesCrawled = pages.filter((p) => p.facts).length;
  const brokenOrRedirect = (l) => l.error || (l.status ?? 0) >= 400 || l.redirected;

  console.log(JSON.stringify({
    site,
    userAgent: USER_AGENT,
    requests: requestCount,
    sitemap: { ...sitemap, urls: undefined, sampleUrls: sitemap.urls.slice(0, 5) },
    limits: { maxPages: opts.maxPages, maxLinks: opts.maxLinks, pagesCrawled: pages.length, htmlPages: internalPagesCrawled, linksFound: candidates.length, linksChecked: links.length },
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
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: "crawl_failed", detail: errText(err) }));
  process.exitCode = 1;
});
