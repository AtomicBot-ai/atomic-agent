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
    expect(body).toMatch(/tools\.shell\.envPassthrough/);
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
});
