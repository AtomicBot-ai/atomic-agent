import { describe, expect, it } from "vitest";
import { isAllowedByRobots, parseRobotsTxt, patternMatches } from "./robots-txt.js";

const allowed = (txt: string, url: string): boolean =>
  isAllowedByRobots(parseRobotsTxt(txt), new URL(url));

describe("parseRobotsTxt", () => {
  it("applies the * group when no group names us", () => {
    const txt = "User-agent: *\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /";
    expect(allowed(txt, "https://x.com/private/a")).toBe(false);
    expect(allowed(txt, "https://x.com/public")).toBe(true);
  });

  it("prefers a group that names atomic-agent over *", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Atomic-Agent\nDisallow: /admin";
    expect(allowed(txt, "https://x.com/docs")).toBe(true);
    expect(allowed(txt, "https://x.com/admin/x")).toBe(false);
  });

  it("joins consecutive user-agent lines into one group", () => {
    const txt = "User-agent: foo\nUser-agent: *\nDisallow: /tmp\nUser-agent: bar\nDisallow: /";
    expect(allowed(txt, "https://x.com/tmp/1")).toBe(false);
    expect(allowed(txt, "https://x.com/ok")).toBe(true);
  });

  it("lets the longest pattern win and Allow win a tie", () => {
    const txt = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\nAllow: /same\nDisallow: /same";
    expect(allowed(txt, "https://x.com/docs/secret")).toBe(false);
    expect(allowed(txt, "https://x.com/docs/public/page")).toBe(true);
    expect(allowed(txt, "https://x.com/same")).toBe(true);
  });

  it("treats an empty Disallow as no rule and ignores comments", () => {
    const txt = "# hello\nUser-agent: * # everyone\nDisallow:\n";
    expect(allowed(txt, "https://x.com/anything")).toBe(true);
  });

  it("reads Crawl-delay and Sitemap lines", () => {
    const policy = parseRobotsTxt(
      "Sitemap: https://x.com/sitemap.xml\nUser-agent: *\nCrawl-delay: 5\nDisallow: /a\nSitemap: https://x.com/s2.xml",
    );
    expect(policy.crawlDelaySeconds).toBe(5);
    expect(policy.sitemaps).toEqual(["https://x.com/sitemap.xml", "https://x.com/s2.xml"]);
  });

  it("matches the query string and always allows /robots.txt", () => {
    const txt = "User-agent: *\nDisallow: /*?session=\nDisallow: /";
    expect(allowed(txt, "https://x.com/robots.txt")).toBe(true);
    expect(allowed(txt, "https://x.com/page?session=1")).toBe(false);
  });
});

describe("patternMatches", () => {
  it("supports * and the $ end anchor", () => {
    expect(patternMatches("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(patternMatches("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(patternMatches("/fish", "/fish.html")).toBe(true);
    expect(patternMatches("/fish", "/Fish")).toBe(false);
  });

  it("compares unreserved percent-escapes as their characters", () => {
    expect(patternMatches("/~user", "/%7Euser/x")).toBe(true);
  });

  it("does not treat regex characters in a pattern as regex", () => {
    expect(patternMatches("/a.b", "/axb")).toBe(false);
    expect(patternMatches("/a(b)", "/a(b)/c")).toBe(true);
  });
});
