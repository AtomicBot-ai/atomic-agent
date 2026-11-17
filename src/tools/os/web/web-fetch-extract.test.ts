import { describe, it, expect, vi } from "vitest";
import {
  extractWebContent,
  extractWebContentAsync,
  type DefuddleRunner,
} from "./web-fetch-extract.js";

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

const CODE_ARTICLE_HTML = `<!doctype html><html><head><title>Code Post</title></head><body>
<nav>Home About Contact</nav>
<article><h1>Using the API</h1>
<p>This article explains how to call the API from a small script, with enough
prose around the example for an extractor to treat it as the main content.</p>
<pre><code class="language-ts">const answer: number = 42;
console.log(answer);</code></pre>
<p>A closing paragraph that adds more readable prose to the article body and
keeps the example in context for the reader.</p>
</article><footer>footer links</footer></body></html>`;

describe("extractWebContentAsync (ATO-698)", () => {
  const fakeDefuddle = (
    out: { content: string; title?: string } | null | Error,
  ): DefuddleRunner & { calls: Array<{ url: string; markdown: boolean }> } => {
    const calls: Array<{ url: string; markdown: boolean }> = [];
    const run = (async ({ url, markdown }) => {
      calls.push({ url, markdown });
      if (out instanceof Error) throw out;
      return out;
    }) as DefuddleRunner & { calls: typeof calls };
    run.calls = calls;
    return run;
  };

  it("keeps Readability by default and never calls Defuddle", async () => {
    const run = fakeDefuddle({ content: "never used" });
    const res = await extractWebContentAsync({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "markdown",
      runDefuddle: run,
    });
    expect(res.extractor).toBe("readability");
    expect(run.calls).toEqual([]);
  });

  it("uses Defuddle first when preferred, reporting extractor defuddle", async () => {
    const run = fakeDefuddle({ content: "# Heading\n\nbody from defuddle", title: "T" });
    const res = await extractWebContentAsync({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "markdown",
      preferred: "defuddle",
      runDefuddle: run,
    });
    expect(res).toEqual({
      text: "# Heading\n\nbody from defuddle",
      title: "T",
      extractor: "defuddle",
    });
    expect(run.calls).toEqual([{ url: "https://x.test/article", markdown: true }]);
  });

  it("asks Defuddle for HTML in text mode and strips it to plain text", async () => {
    const run = fakeDefuddle({ content: "<p>Plain <b>words</b> here</p>" });
    const res = await extractWebContentAsync({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "text",
      preferred: "defuddle",
      runDefuddle: run,
    });
    expect(res.extractor).toBe("defuddle");
    expect(res.text).toContain("Plain words here");
    expect(res.text).not.toContain("<b>");
    expect(run.calls[0]?.markdown).toBe(false);
  });

  it.each([
    ["finds nothing", null],
    ["throws", new Error("boom")],
    ["returns blank content", { content: "   " }],
  ] as const)("falls back to Readability when Defuddle %s", async (_label, out) => {
    const res = await extractWebContentAsync({
      body: ARTICLE_HTML,
      contentType: "text/html",
      url: "https://x.test/article",
      mode: "markdown",
      preferred: "defuddle",
      runDefuddle: fakeDefuddle(out),
    });
    expect(res.extractor).toBe("readability");
    expect(res.text).toContain("first substantial paragraph");
  });

  it("does not run Defuddle on markdown or non-HTML bodies", async () => {
    const run = fakeDefuddle({ content: "never used" });
    const md = await extractWebContentAsync({
      body: "# Title",
      contentType: "text/markdown",
      url: "https://x.test",
      mode: "markdown",
      preferred: "defuddle",
      runDefuddle: run,
    });
    const json = await extractWebContentAsync({
      body: '{"a":1}',
      contentType: "application/json",
      url: "https://x.test",
      mode: "markdown",
      preferred: "defuddle",
      runDefuddle: run,
    });
    expect(md.extractor).toBe("cf-markdown");
    expect(json.extractor).toBe("raw");
    expect(run.calls).toEqual([]);
  });

  it("runs the real Defuddle package offline and keeps a fenced code block", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await extractWebContentAsync({
        body: CODE_ARTICLE_HTML,
        contentType: "text/html",
        url: "https://x.test/post",
        mode: "markdown",
        preferred: "defuddle",
      });
      expect(res.extractor).toBe("defuddle");
      expect(res.text).toContain("```");
      expect(res.text).toContain("const answer: number = 42;");
      expect(res.text).toContain("main content");
      expect(res.text).not.toContain("footer links");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
