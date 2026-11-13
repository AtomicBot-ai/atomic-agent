import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/** The pure helpers `scripts/seo-lib.mjs` exports (plain JS, typed here). */
interface SeoLib {
  USER_AGENT: string;
  parseRobots(text: string): { rules: unknown[]; crawlDelay: number | null; sitemaps: string[] };
  isAllowed(robots: unknown, url: string): boolean;
  parseSitemap(xml: string): { isIndex: boolean; locs: string[] };
  extractPageFacts(html: string, url: string): {
    titles: string[];
    description: string | null;
    canonical: string | null;
    h1s: string[];
    jsonLd: { count: number; valid: number; types: string[]; errors: string[] };
    links: string[];
    imagesMissingAlt: number;
  };
  buildFindings(input: unknown): { check: string; count: number; urls: string[] }[];
  summarizePageSpeed(json: unknown, strategy: string): {
    performanceScore: number | null;
    fieldData: { lcpMs: { p75: number; category: string } | null } | null;
    lab: { lcpMs: number | null };
    opportunities: { id: string; savingsMs: number }[];
  };
}

/** What `scripts/crawl.mjs` exports for tests (plain JS, typed here). */
interface CrawlReport {
  error?: string;
  partial?: boolean;
  partialReason?: string;
  requests: number;
  elapsedSeconds: number;
  site: { origin: string; delayMs: number };
  sitemap: { found: boolean; urlCount: number; otherHostUrls: number };
  limits: { pagesCrawled: number; linksChecked: number; deadlineSeconds: number };
  pages: { url: string }[];
  linkProblems: { url: string; internal: boolean; redirected?: boolean }[];
}
interface CrawlModule {
  parseArgs(argv: string[]): Record<string, unknown> & { delayMs: number; deadlineSeconds: number };
  budgetFor(deadlineSeconds: number): { hardMs: number; softMs: number };
  startCrawl(
    opts: Record<string, unknown>,
    deps: { fetch: FetchStub; now: () => number; sleep: (ms: number) => Promise<void> },
  ): { done: Promise<CrawlReport>; snapshot(reason: string | null): CrawlReport };
}
type FetchStub = (url: string, init: { method: string }) => Promise<unknown>;
type Route = { status?: number; body?: string; type?: string } | undefined;

/**
 * A fake network: `routes(url)` answers each URL, and every request to
 * the apex `x.test` is answered as if it had been redirected to
 * `www.x.test`, the way `example.com` -> `www.example.com` works.
 */
function fakeFetch(routes: (url: string) => Route, log: string[] = []): FetchStub {
  return async (url, init) => {
    log.push(`${init.method} ${url}`);
    const u = new URL(url);
    let redirected = false;
    if (u.host === "x.test") {
      u.host = "www.x.test";
      redirected = true;
    }
    const r = routes(u.href);
    const status = r?.status ?? (r ? 200 : 404);
    const text = r?.body ?? "";
    return {
      ok: status < 400,
      status,
      url: u.href,
      redirected,
      headers: new Headers({ "content-type": r?.type ?? "text/html" }),
      body: text ? {} : null,
      text: async () => text,
    };
  };
}

/** A clock that only moves when the crawler waits, so no test sleeps. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const htmlPage = (title: string, links: string[]) =>
  `<html lang="en"><head><title>${title}</title></head><body><h1>x</h1>${links.map((l) => `<a href="${l}">l</a>`).join("")}</body></html>`;

/**
 * The `seo-audit` starter (ATO-972) answers "check my site" with a short
 * report split into quick wins and strategic work. These cases pin what
 * makes it safe to run against someone's site (read-only, robots.txt,
 * small cap, delay, own user agent) and the report shape, plus the pure
 * parts of the crawler that decide what gets reported.
 */
describe("the seo-audit starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const skillDir = join(dir, "seo-audit");
  const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const crawl = readFileSync(join(skillDir, "scripts", "crawl.mjs"), "utf8");
  const pagespeed = readFileSync(join(skillDir, "scripts", "pagespeed.mjs"), "utf8");
  const loadLib = async (): Promise<SeoLib> =>
    (await import(pathToFileURL(join(skillDir, "scripts", "seo-lib.mjs")).href)) as SeoLib;
  const loadCrawl = async (): Promise<CrawlModule> =>
    (await import(pathToFileURL(join(skillDir, "scripts", "crawl.mjs")).href)) as CrawlModule;

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("seo-audit");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("seo-audit");
    expect(parsed.manifest.requiresScripts).toEqual(["crawl.mjs", "pagespeed.mjs"]);
  });

  it("is picked for 'check my site'", () => {
    expect(body).toMatch(/description:.*check my site/);
    expect(body).toMatch(/description:.*quick wins and strategic/);
  });

  it("stays read-only and polite toward the site", () => {
    expect(body).toMatch(/GET and HEAD requests only\. Never submit a form/);
    expect(body).toMatch(/robots\.txt is read first and obeyed/);
    expect(body).toMatch(/20 pages by default, 50 at most/);
    expect(body).toMatch(/delay between\s+every request/);
    expect(crawl).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(crawl).toMatch(/maxPages: \[20, 1, 50\]/);
    expect(crawl).toMatch(/delayMs: \[1000, 500, 10000\]/);
    expect(crawl).toMatch(/robots_unreachable/);
  });

  it("sends its own user agent", async () => {
    const lib = await loadLib();
    expect(lib.USER_AGENT).toMatch(/^AtomicAgent-SEO-Audit\//);
    expect(crawl).toMatch(/"User-Agent": USER_AGENT/);
  });

  it("obeys robots.txt: our group over *, longest rule wins, Allow wins ties", async () => {
    const lib = await loadLib();
    const robots = lib.parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: AtomicAgent-SEO-Audit\nDisallow: /private\nAllow: /private/ok$\nCrawl-delay: 3\nSitemap: https://x.test/sm.xml\n",
    );
    expect(robots.crawlDelay).toBe(3);
    expect(robots.sitemaps).toEqual(["https://x.test/sm.xml"]);
    expect(lib.isAllowed(robots, "https://x.test/")).toBe(true);
    expect(lib.isAllowed(robots, "https://x.test/private/a")).toBe(false);
    expect(lib.isAllowed(robots, "https://x.test/private/ok")).toBe(true);
    expect(lib.isAllowed(lib.parseRobots("User-agent: *\nDisallow: /\n"), "https://x.test/")).toBe(false);
    expect(lib.isAllowed(lib.parseRobots(""), "https://x.test/any")).toBe(true);
  });

  it("reads sitemaps and sitemap indexes", async () => {
    const lib = await loadLib();
    expect(lib.parseSitemap("<urlset><url><loc> https://x.test/a?x=1&amp;y=2 </loc></url></urlset>")).toEqual({
      isIndex: false,
      locs: ["https://x.test/a?x=1&y=2"],
    });
    expect(lib.parseSitemap("<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>").isIndex).toBe(true);
  });

  it("checks title, description, H1, canonical, JSON-LD and links", async () => {
    const lib = await loadLib();
    const html = `<html lang="en"><head><title>Short</title>
      <link rel="canonical" href="/other">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization"}]}</script>
      <script type="application/ld+json">{broken</script></head>
      <body><!-- <h1>hidden</h1> --><a href="/b#top">b</a><a href="mailto:a@x.test">m</a><img src="a.png"></body></html>`;
    const facts = lib.extractPageFacts(html, "https://x.test/a");
    expect(facts.titles).toEqual(["Short"]);
    expect(facts.description).toBeNull();
    expect(facts.h1s).toEqual([]);
    expect(facts.canonical).toBe("https://x.test/other");
    expect(facts.jsonLd).toMatchObject({ count: 2, valid: 1, types: ["Organization"] });
    expect(facts.links).toEqual(["https://x.test/b"]);
    expect(facts.imagesMissingAlt).toBe(1);

    const checks = lib
      .buildFindings({
        pages: [{ url: "https://x.test/a", finalUrl: "https://x.test/a", status: 200, inSitemap: true, facts }],
        links: [{ url: "https://x.test/b", internal: true, status: 404, foundOn: ["https://x.test/a"] }],
        site: { origin: "https://x.test", sitemapFound: false },
      })
      .map((f) => f.check);
    for (const id of [
      "no_sitemap",
      "title_too_short",
      "missing_description",
      "missing_h1",
      "canonical_points_elsewhere",
      "invalid_json_ld",
      "images_missing_alt",
      "broken_internal_link",
    ]) {
      expect(checks).toContain(id);
    }
  });

  it("splits the report into quick wins and strategic, with affected URLs", () => {
    expect(body).toMatch(/## Step 3: sort into quick wins and strategic/);
    expect(body).toMatch(/### Quick wins/);
    expect(body).toMatch(/### Strategic/);
    expect(body).toMatch(/\*\*Affected URLs\*\*/);
    // Every check id the crawler can emit has a bucket in the table.
    for (const m of readFileSync(join(skillDir, "scripts", "seo-lib.mjs"), "utf8").matchAll(/add\(f, "([a-z_]+)"/g)) {
      expect(body).toContain("`" + m[1] + "`");
    }
  });

  it("measures Core Web Vitals through PageSpeed Insights with an optional key", async () => {
    expect(pagespeed).toMatch(/pagespeedonline\/v5\/runPagespeed/);
    expect(pagespeed).toMatch(/process\.env\.PAGESPEED_API_KEY/);
    expect(body).toMatch(/PAGESPEED_API_KEY/);
    // The key reaches this skill's scripts through its own env_keys, not
    // through the global passthrough list (product decision on ATO-972).
    expect(parseSkillFile(body).manifest.envKeys).toEqual(["PAGESPEED_API_KEY"]);
    expect(body).not.toMatch(/envPassthrough/);
    expect(body).toMatch(/Never ask the user to paste the key into the chat/);
    const lib = await loadLib();
    const summary = lib.summarizePageSpeed(
      {
        id: "https://x.test/",
        loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: "AVERAGE" } } },
        lighthouseResult: {
          categories: { performance: { score: 0.42 } },
          audits: {
            "largest-contentful-paint": { numericValue: 4200.4 },
            "render-blocking-resources": { id: "render-blocking-resources", title: "x", score: 0.3, details: { type: "opportunity", overallSavingsMs: 900 } },
            "uses-webp-images": { id: "uses-webp-images", title: "y", score: 1, details: { type: "opportunity", overallSavingsMs: 50 } },
          },
        },
      },
      "mobile",
    );
    expect(summary.performanceScore).toBe(42);
    expect(summary.fieldData?.lcpMs).toEqual({ p75: 3100, category: "AVERAGE" });
    expect(summary.lab.lcpMs).toBe(4200.4);
    expect(summary.opportunities).toEqual([{ id: "render-blocking-resources", title: "x", savingsMs: 900 }]);
  });
  it("crawls the www host when a bare domain redirects there", async () => {
    const { startCrawl, parseArgs } = await loadCrawl();
    const routes = (u: string): Route =>
      (({
        "https://www.x.test/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://www.x.test/sitemap.xml\n", type: "text/plain" },
        "https://www.x.test/sitemap.xml": {
          body: "<urlset><url><loc>https://www.x.test/</loc></url><url><loc>https://www.x.test/a</loc></url><url><loc>https://www.x.test/b</loc></url></urlset>",
          type: "application/xml",
        },
        "https://www.x.test/": { body: htmlPage("Home page of the x test site", ["/a", "https://x.test/b"]) },
        "https://www.x.test/a": { body: htmlPage("Page A of the x test site", []) },
        "https://www.x.test/b": { body: htmlPage("Page B of the x test site", []) },
      }) as Record<string, Route>)[u];
    const report = await startCrawl(parseArgs(["x.test"]), { fetch: fakeFetch(routes), ...fakeClock() }).done;
    expect(report.site.origin).toBe("https://www.x.test");
    expect(report.limits.pagesCrawled).toBeGreaterThan(1);
    expect(report.sitemap.urlCount).toBe(3);
    expect(report.sitemap.otherHostUrls).toBe(0);
    expect(report.pages.map((p) => p.url)).toEqual(["https://x.test/", "https://www.x.test/a", "https://www.x.test/b"]);
    // A link to the bare twin counts as internal and is reported as a redirect.
    expect(report.linkProblems).toEqual([expect.objectContaining({ url: "https://x.test/b", internal: true, redirected: true })]);
    expect(report.partial).toBeUndefined();
  });

  it("stops inside its time budget with Crawl-delay 5 and still returns the JSON", async () => {
    const { startCrawl, parseArgs, budgetFor } = await loadCrawl();
    // Every page links to ten more, so the default caps (20 pages, 100
    // links) would need well over 600 s at 5 s per request.
    const routes = (u: string): Route => {
      if (u.endsWith("/robots.txt")) return { body: "User-agent: *\nCrawl-delay: 5\n", type: "text/plain" };
      if (u.endsWith("/sitemap.xml")) return undefined;
      const n = Number(new URL(u).pathname.slice(3)) || 0;
      return { body: htmlPage(`Page ${n} of the slow test site`, Array.from({ length: 10 }, (_, i) => `/p/${n * 10 + i + 1}`)) };
    };
    const clock = fakeClock();
    const startedAt = clock.now();
    const opts = parseArgs(["https://slow.test/"]);
    expect(opts.deadlineSeconds).toBe(240);
    const report = await startCrawl(opts, { fetch: fakeFetch(routes), ...clock }).done;
    const { hardMs, softMs } = budgetFor(240);
    expect(report.error).toBeUndefined();
    expect(report.partial).toBe(true);
    expect(report.partialReason).toBe("time_budget");
    expect(report.site.delayMs).toBe(5000);
    expect(report.limits.pagesCrawled).toBeGreaterThan(1);
    expect(clock.now() - startedAt).toBeLessThan(softMs);
    expect(report.elapsedSeconds * 1000).toBeLessThan(hardMs);
    // The SKILL.md runs the crawl with a 300 s timeout.
    expect(hardMs).toBeLessThan(300_000);
  });

  it("never plans more requests than the budget allows, for any delay", async () => {
    const { startCrawl, parseArgs, budgetFor } = await loadCrawl();
    const routes = (u: string): Route => {
      if (u.endsWith("/robots.txt")) return { body: "User-agent: *\n", type: "text/plain" };
      if (u.endsWith("/sitemap.xml")) return undefined;
      const n = Number(new URL(u).pathname.slice(3)) || 0;
      return { body: htmlPage(`Page ${n} of the budget test site`, Array.from({ length: 10 }, (_, i) => `/p/${n * 10 + i + 1}`)) };
    };
    for (const deadline of ["30", "240", "540"]) {
      for (const delay of ["500", "1000", "5000", "10000"]) {
        const opts = parseArgs(["https://budget.test/", "--delay-ms", delay, "--deadline-seconds", deadline, "--max-pages", "50", "--max-links", "300"]);
        const report = await startCrawl(opts, { fetch: fakeFetch(routes), ...fakeClock() }).done;
        const { softMs } = budgetFor(opts.deadlineSeconds);
        // Requests start at 0, delay, 2*delay, ...; the last one starts before the soft limit.
        expect((report.requests - 1) * opts.delayMs).toBeLessThan(softMs);
      }
    }
    expect(budgetFor(240)).toEqual({ hardMs: 240_000, softMs: 192_000 });
  });

  it("prints what it has when stopped from outside (SIGTERM, Ctrl+C)", async () => {
    const { startCrawl, parseArgs } = await loadCrawl();
    const routes = (u: string): Route =>
      u.endsWith("/robots.txt")
        ? { body: "User-agent: *\n", type: "text/plain" }
        : { body: htmlPage("A page of the stop test site", ["/next", "/other"]) };
    const inner = fakeFetch(routes);
    let calls = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    let reachedBlock: () => void = () => {};
    const atBlock = new Promise<void>((r) => { reachedBlock = r; });
    // robots.txt, the home page and the sitemap answer; the 4th request hangs.
    const fetch: FetchStub = async (url, init) => {
      calls += 1;
      if (calls === 4) {
        reachedBlock();
        await blocked;
      }
      return inner(url, init);
    };
    const crawl = startCrawl(parseArgs(["https://stop.test/"]), { fetch, ...fakeClock() });
    await atBlock;
    const snap = crawl.snapshot("stopped_by_SIGTERM");
    expect(snap.partial).toBe(true);
    expect(snap.partialReason).toBe("stopped_by_SIGTERM");
    expect(snap.site.origin).toBe("https://stop.test");
    expect(snap.pages.map((p) => p.url)).toEqual(["https://stop.test/"]);
    release();
    await crawl.done;
  });
});
