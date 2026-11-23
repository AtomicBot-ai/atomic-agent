import { describe, expect, it } from "vitest";
import { describeJsPages, looksJsRendered } from "./crawl-js-page.js";

const SHELL =
  '<!doctype html><html><head><script src="/main.js"></script></head><body><div id="__next"></div></body></html>';

describe("looksJsRendered", () => {
  it("spots an app shell: scripts, a mount point, no text", () => {
    expect(looksJsRendered(SHELL, "text/html; charset=utf-8", "")).toBe(true);
  });

  it("spots a noscript notice", () => {
    const html =
      "<html><body><script>boot()</script><noscript>Please enable JavaScript.</noscript></body></html>";
    expect(looksJsRendered(html, "text/html", "Please enable JavaScript.")).toBe(true);
  });

  it("leaves pages with text, pages without scripts, and non-HTML alone", () => {
    expect(looksJsRendered(SHELL, "text/html", "x".repeat(400))).toBe(false);
    expect(looksJsRendered("<html><body><p>Short.</p></body></html>", "text/html", "Short.")).toBe(false);
    expect(looksJsRendered("<script></script>", "application/json", "")).toBe(false);
    // One inline script and no app markers: just a short page.
    expect(looksJsRendered("<html><body><script>x()</script><p>Hi</p></body></html>", "text/html", "Hi")).toBe(false);
  });
});

describe("describeJsPages", () => {
  it("names the pages and the browser tools", () => {
    const line = describeJsPages(["https://a/1", "https://a/2", "https://a/3", "https://a/4"]);
    expect(line).toContain("4 page(s)");
    expect(line).toContain("and 1 more");
    expect(line).toContain("browser.navigate");
  });
});
