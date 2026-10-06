import { describe, it, expect } from "vitest";
import { extractWebContent } from "./web-fetch-extract.js";

const ARTICLE_HTML = `<!doctype html><html><head><title>My Title</title>
<style>.x{color:red}</style></head><body>
<nav>menu menu menu</nav>
<article><h1>Heading One</h1>
<p>This is the first substantial paragraph with enough words to satisfy
Readability's character threshold so that the main content is detected.</p>
<p>A second paragraph, also reasonably long, continues the article body and
provides additional readable prose for the extractor to keep.</p>
<script>window.tracker = 1;</script>
</article>
<footer>copyright</footer></body></html>`;

describe("extractWebContent", () => {
  it("uses cf-markdown verbatim in markdown mode", () => {
    const res = extractWebContent({
      body: "# Title\n\nbody text",
      contentType: "text/markdown; charset=utf-8",
      url: "https://x.test",
      mode: "markdown",
    });
    expect(res.extractor).toBe("cf-markdown");
    expect(res.text).toBe("# Title\n\nbody text");
  });

  it("strips cf-markdown to plain text in text mode", () => {
    const res = extractWebContent({
      body: "# Title\n\n**bold** body",
      contentType: "text/markdown",
      url: "https://x.test",
      mode: "text",
    });
    expect(res.extractor).toBe("cf-markdown");
    // html-to-text upper-cases headings by default; match case-insensitively.
    expect(res.text.toLowerCase()).toContain("title");
    expect(res.text).toContain("bold");
    expect(res.text).not.toContain("**");
    expect(res.text).not.toContain("#");
  });

  it("extracts main content via Readability and converts to markdown", () => {
    const res = extractWebContent({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "markdown",
    });
    expect(res.extractor).toBe("readability");
    expect(res.title).toBe("My Title");
    expect(res.text).toContain("first substantial paragraph");
    expect(res.text).not.toContain("menu menu menu");
    expect(res.text).not.toContain("window.tracker");
  });

  it("returns readable plain text in text mode", () => {
    const res = extractWebContent({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "text",
    });
    expect(res.extractor).toBe("readability");
    expect(res.text).toContain("second paragraph");
  });

  it("falls back to basic extraction when Readability finds no article", () => {
    // Script-only body: Readability returns null, so the basic
    // tag-stripping path runs and must not leak inline script source.
    const res = extractWebContent({
      body: "<html><body><script>evil()</script>   </body></html>",
      contentType: "text/html",
      url: "https://x.test",
      mode: "text",
    });
    expect(res.extractor).toBe("basic");
    expect(res.text).not.toContain("evil(");
  });

  it("returns non-HTML, non-markdown payloads untouched", () => {
    const json = '{"a":1,"b":[2,3]}';
    const res = extractWebContent({
      body: json,
      contentType: "application/json",
      url: "https://api.test",
      mode: "markdown",
    });
    expect(res.extractor).toBe("raw");
    expect(res.text).toBe(json);
  });
});
