// Pure helpers for the seo-audit starter skill: robots.txt rules, sitemap
// parsing, on-page facts from HTML, the findings list and the PageSpeed
// summary. No network and no file access here, so the parts that decide
// what gets reported can be tested on their own. Node built-ins only.

export const USER_AGENT = "AtomicAgent-SEO-Audit/1.0";
const UA_TOKEN = "atomicagent-seo-audit";

/** Parse robots.txt into the rule group that applies to us. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (key === "allow" || key === "disallow") {
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  const ours = groups.find((g) => g.agents.some((a) => a.split("/")[0] === UA_TOKEN));
  const any = groups.find((g) => g.agents.includes("*"));
  const group = ours ?? any ?? { rules: [], crawlDelay: null };
  return { rules: group.rules, crawlDelay: group.crawlDelay, sitemaps };
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + re + (anchored ? "$" : "")).test(path);
}

/** Longest matching rule wins; on a tie Allow wins. No rule means allowed. */
export function isAllowed(robots, url) {
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  let best = null;
  for (const rule of robots?.rules ?? []) {
    if (!ruleMatches(rule.path, path)) continue;
    if (best === null || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return best === null || best.allow;
}

/** `<loc>` entries of a urlset or a sitemapindex. */
export function parseSitemap(xml) {
  const text = String(xml);
  const isIndex = /<sitemapindex\b/i.test(text);
  const locs = [];
  for (const m of text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    locs.push(decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim()));
  }
  return { isIndex, locs };
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

const textOf = (html) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function collectTypes(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
  } else if (node && typeof node === "object") {
    const t = node["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) out.push(...t.filter((x) => typeof x === "string"));
    if (node["@graph"]) collectTypes(node["@graph"], out);
  }
}

/** On-page SEO facts from one HTML document. */
export function extractPageFacts(html, pageUrl) {
  const doc = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const titles = [...doc.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => textOf(m[1]));
  const metas = [...doc.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaContent = (n) => {
    const tag = metas.find((t) => (attr(t, "name") ?? "").toLowerCase() === n);
    return tag ? attr(tag, "content") ?? "" : null;
  };
  const links = [...doc.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const canonicalTag = links.find((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  let canonical = canonicalTag ? attr(canonicalTag, "href") : null;
  if (canonical) {
    try { canonical = new URL(canonical, pageUrl).href; } catch { /* keep as written */ }
  }
  const h1s = [...doc.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => textOf(m[1]));
  const htmlTag = /<html\b[^>]*>/i.exec(doc)?.[0] ?? "";
  const jsonLd = { count: 0, valid: 0, types: [], errors: [] };
  for (const m of doc.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    jsonLd.count += 1;
    try {
      collectTypes(JSON.parse(m[1]), jsonLd.types);
      jsonLd.valid += 1;
    } catch (err) {
      jsonLd.errors.push(String(err?.message ?? err).slice(0, 120));
    }
  }
  const hrefs = new Set();
  for (const m of doc.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      hrefs.add(u.href);
    } catch { /* unparsable href, ignore */ }
  }
  const imgs = [...doc.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  return {
    titles,
    description: metaContent("description"),
    metaRobots: metaContent("robots"),
    viewport: metaContent("viewport") !== null,
    lang: attr(htmlTag, "lang"),
    canonical,
    h1s,
    jsonLd,
    links: [...hrefs],
    imagesMissingAlt: imgs.filter((t) => attr(t, "alt") === null).length,
  };
}

const MAX_URLS = 20;
const add = (map, check, url, detail) => {
  const f = map.get(check) ?? { check, count: 0, urls: [], details: [] };
  f.count += 1;
  if (f.urls.length < MAX_URLS) f.urls.push(url);
  if (detail !== undefined && f.details.length < MAX_URLS) f.details.push(detail);
  map.set(check, f);
};

/**
 * Turn crawled pages and checked links into findings, one entry per
 * check id with the affected URLs. A page is
 * `{ url, finalUrl, status, error, html, xRobots, inSitemap, facts }`.
 */
export function buildFindings({ pages, links = [], site = {} }) {
  const f = new Map();
  if (site.robotsBlocksAll) add(f, "robots_blocks_site", site.origin);
  if (!site.sitemapFound) add(f, "no_sitemap", site.origin);
  const byTitle = new Map();
  const byDesc = new Map();
  for (const p of pages) {
    if (p.error || (p.status ?? 0) >= 400) {
      add(f, p.inSitemap ? "sitemap_url_broken" : "page_error", p.url, p.error ?? p.status);
      continue;
    }
    if (p.inSitemap && p.finalUrl && p.finalUrl !== p.url) add(f, "sitemap_url_redirects", p.url, p.finalUrl);
    if (!p.facts) continue;
    const x = p.facts;
    const noindex = /noindex/i.test(x.metaRobots ?? "") || /noindex/i.test(p.xRobots ?? "");
    if (noindex) add(f, p.inSitemap ? "sitemap_url_noindex" : "noindex", p.url);
    const title = x.titles[0] ?? "";
    if (!title) add(f, "missing_title", p.url);
    else {
      if (title.length > 60) add(f, "title_too_long", p.url, title.length);
      if (title.length < 15) add(f, "title_too_short", p.url, title.length);
      if (!noindex) byTitle.set(title, [...(byTitle.get(title) ?? []), p.url]);
    }
    if (x.titles.length > 1) add(f, "multiple_titles", p.url, x.titles.length);
    const desc = x.description ?? "";
    if (!desc) add(f, "missing_description", p.url);
    else {
      if (desc.length > 160) add(f, "description_too_long", p.url, desc.length);
      if (desc.length < 50) add(f, "description_too_short", p.url, desc.length);
      if (!noindex) byDesc.set(desc, [...(byDesc.get(desc) ?? []), p.url]);
    }
    if (x.h1s.length === 0) add(f, "missing_h1", p.url);
    if (x.h1s.length > 1) add(f, "multiple_h1", p.url, x.h1s.length);
    if (!x.canonical) add(f, "missing_canonical", p.url);
    else if (x.canonical !== (p.finalUrl ?? p.url)) {
      let other = false;
      try { other = new URL(x.canonical).host !== new URL(p.url).host; } catch { other = true; }
      add(f, other ? "canonical_other_host" : "canonical_points_elsewhere", p.url, x.canonical);
    }
    if (x.jsonLd.count === 0) add(f, "no_structured_data", p.url);
    if (x.jsonLd.errors.length > 0) add(f, "invalid_json_ld", p.url, x.jsonLd.errors[0]);
    if (!x.lang) add(f, "missing_lang", p.url);
    if (!x.viewport) add(f, "missing_viewport", p.url);
    if (x.imagesMissingAlt > 0) add(f, "images_missing_alt", p.url, x.imagesMissingAlt);
  }
  for (const [title, urls] of byTitle) if (urls.length > 1) for (const u of urls) add(f, "duplicate_title", u, title);
  for (const [desc, urls] of byDesc) if (urls.length > 1) for (const u of urls) add(f, "duplicate_description", u, desc.slice(0, 80));
  for (const l of links) {
    if (l.skipped) continue;
    if (l.error || (l.status ?? 0) >= 400) {
      add(f, l.internal ? "broken_internal_link" : "broken_external_link", l.url, { status: l.status ?? l.error, foundOn: l.foundOn });
    } else if (l.internal && l.redirected) {
      add(f, "internal_link_redirects", l.url, { to: l.finalUrl, foundOn: l.foundOn });
    }
  }
  return [...f.values()];
}

/** The parts of a PageSpeed Insights v5 response the report needs. */
export function summarizePageSpeed(json, strategy) {
  const field = (exp) => {
    const m = exp?.metrics;
    if (!m) return null;
    const pick = (k) => (m[k] ? { p75: m[k].percentile, category: m[k].category } : null);
    return {
      lcpMs: pick("LARGEST_CONTENTFUL_PAINT_MS"),
      inpMs: pick("INTERACTION_TO_NEXT_PAINT"),
      // CrUX reports CLS multiplied by 100.
      clsX100: pick("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
      overall: exp.overall_category ?? null,
    };
  };
  const lh = json?.lighthouseResult ?? {};
  const audits = lh.audits ?? {};
  const num = (id) => (typeof audits[id]?.numericValue === "number" ? Math.round(audits[id].numericValue * 1000) / 1000 : null);
  const opportunities = Object.values(audits)
    .filter((a) => a?.details?.type === "opportunity" && typeof a.score === "number" && a.score < 0.9)
    .map((a) => ({ id: a.id, title: a.title, savingsMs: Math.round(a.details.overallSavingsMs ?? 0) }))
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, 5);
  const score = lh.categories?.performance?.score;
  return {
    url: json?.id ?? lh.finalUrl ?? null,
    strategy,
    performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
    fieldData: field(json?.loadingExperience),
    originFieldData: field(json?.originLoadingExperience),
    lab: {
      lcpMs: num("largest-contentful-paint"),
      cls: num("cumulative-layout-shift"),
      tbtMs: num("total-blocking-time"),
      fcpMs: num("first-contentful-paint"),
    },
    opportunities,
  };
}
