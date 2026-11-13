import { describe, expect, it } from "vitest";
import {
  extractHtmlLinks,
  extractMarkdownLinks,
  extractPageLinks,
  inCrawlScope,
  normaliseCrawlUrl,
  parseSitemap,
} from "./crawl-links.js";

const page = new URL("https://docs.x.com/guide/intro");
const hrefs = (urls: URL[]): string[] => urls.map((u) => u.toString());

describe("extractHtmlLinks", () => {
  it("resolves relative links and drops fragments-only, mailto and javascript links", () => {
    const html = `<html><body>
      <a href="setup">Setup</a>
      <a href="/api/">API</a>
      <a href="#top">Top</a>
      <a href="mailto:a@b.c">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a href="https://other.com/x">Other</a>
    </body></html>`;
    expect(hrefs(extractHtmlLinks(html, page).links)).toEqual([
      "https://docs.x.com/guide/setup",
      "https://docs.x.com/api/",
      "https://other.com/x",
    ]);
  });

  it("honours <base href> and rel=nofollow", () => {
    const html = `<html><head><base href="https://docs.x.com/v2/"></head><body>
      <a href="a">A</a><a rel="nofollow sponsored" href="b">B</a></body></html>`;
    expect(hrefs(extractHtmlLinks(html, page).links)).toEqual(["https://docs.x.com/v2/a"]);
  });

  it("follows nothing from a page whose robots meta says nofollow", () => {
    const html = `<html><head><meta name="robots" content="noindex, nofollow"></head>
      <body><a href="/a">A</a></body></html>`;
    expect(extractHtmlLinks(html, page)).toEqual({ links: [], nofollow: true });
  });
});

describe("extractMarkdownLinks", () => {
  it("reads inline links and reference definitions", () => {
    const md = 'See [setup](setup.md "Setup") and [api](</api/>).\n\n[ref]: https://docs.x.com/ref\n';
    expect(hrefs(extractMarkdownLinks(md, page).links)).toEqual([
      "https://docs.x.com/guide/setup.md",
      "https://docs.x.com/api/",
      "https://docs.x.com/ref",
    ]);
  });
});

describe("extractPageLinks", () => {
  it("picks the parser by content type and finds nothing in JSON", () => {
    expect(extractPageLinks("[a](/a)", "text/markdown; charset=utf-8", page).links).toHaveLength(1);
    expect(extractPageLinks('<a href="/a">a</a>', "text/html", page).links).toHaveLength(1);
    expect(extractPageLinks('{"a":"/a"}', "application/json", page).links).toHaveLength(0);
  });
});

describe("inCrawlScope", () => {
  const start = new URL("https://docs.x.com/guide/");
  it("keeps the crawl on one origin and under the path prefix", () => {
    expect(inCrawlScope(new URL("https://docs.x.com/guide/a"), start, null)).toBe(true);
    expect(inCrawlScope(new URL("http://docs.x.com/guide/a"), start, null)).toBe(false);
    expect(inCrawlScope(new URL("https://x.com/guide/a"), start, null)).toBe(false);
    expect(inCrawlScope(new URL("https://docs.x.com/blog/a"), start, "/guide/")).toBe(false);
    expect(inCrawlScope(new URL("https://docs.x.com/guide/a"), start, "/guide/")).toBe(true);
  });

  it("skips files a page reader cannot use", () => {
    expect(inCrawlScope(new URL("https://docs.x.com/logo.PNG"), start, null)).toBe(false);
    expect(inCrawlScope(new URL("https://docs.x.com/dl/app.zip"), start, null)).toBe(false);
    expect(inCrawlScope(new URL("https://docs.x.com/page.html"), start, null)).toBe(true);
  });
});

describe("normaliseCrawlUrl", () => {
  it("drops the fragment so #sections are one page", () => {
    expect(normaliseCrawlUrl(new URL("https://x.com/a#b"))).toBe("https://x.com/a");
  });
});

describe("parseSitemap", () => {
  it("reads page URLs from a urlset, decoding entities and CDATA", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://x.com/a?x=1&amp;y=2</loc></url>
      <url><loc><![CDATA[https://x.com/b]]></loc></url>
      <url><loc>not a url</loc></url>
    </urlset>`;
    expect(parseSitemap(xml)).toEqual({ pages: ["https://x.com/a?x=1&y=2", "https://x.com/b"], sitemaps: [] });
  });

  it("reads child sitemaps from a sitemap index", () => {
    const xml = `<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ pages: [], sitemaps: ["https://x.com/s1.xml"] });
  });

  it("yields nothing for an HTML 'not found' page", () => {
    expect(parseSitemap("<html><body>Not found</body></html>")).toEqual({ pages: [], sitemaps: [] });
  });
});
