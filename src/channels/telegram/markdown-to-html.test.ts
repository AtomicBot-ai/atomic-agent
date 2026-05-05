import { describe, expect, it } from "vitest";

import {
  convertMarkdownToTelegramHtml,
  escapeHtmlText,
} from "./markdown-to-html.js";

describe("escapeHtmlText", () => {
  it("escapes the three structural HTML characters", () => {
    expect(escapeHtmlText("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });

  it("returns empty input as-is", () => {
    expect(escapeHtmlText("")).toBe("");
  });
});

describe("convertMarkdownToTelegramHtml", () => {
  it("returns empty string for empty input", () => {
    expect(convertMarkdownToTelegramHtml("")).toBe("");
  });

  it("escapes raw HTML characters in plain prose", () => {
    expect(convertMarkdownToTelegramHtml("if a < b && b > 0")).toBe(
      "if a &lt; b &amp;&amp; b &gt; 0",
    );
  });

  it("renders bold via ** and __ as <b>", () => {
    expect(convertMarkdownToTelegramHtml("**hello** and __world__")).toBe(
      "<b>hello</b> and <b>world</b>",
    );
  });

  it("renders italic via single * and _ as <i>", () => {
    expect(convertMarkdownToTelegramHtml("an *emphasised* word")).toBe(
      "an <i>emphasised</i> word",
    );
    expect(convertMarkdownToTelegramHtml("an _emphasised_ word")).toBe(
      "an <i>emphasised</i> word",
    );
  });

  it("does not italicise underscores inside identifiers", () => {
    expect(convertMarkdownToTelegramHtml("snake_case_identifier")).toBe(
      "snake_case_identifier",
    );
  });

  it("renders strikethrough via ~~", () => {
    expect(convertMarkdownToTelegramHtml("~~old~~ new")).toBe(
      "<s>old</s> new",
    );
  });

  it("renders inline code via single backticks and escapes the body", () => {
    expect(convertMarkdownToTelegramHtml("call `foo<bar>` now")).toBe(
      "call <code>foo&lt;bar&gt;</code> now",
    );
  });

  it("does not interpret markdown inside inline code", () => {
    expect(convertMarkdownToTelegramHtml("code `**not bold**` here")).toBe(
      "code <code>**not bold**</code> here",
    );
  });

  it("renders fenced code blocks without a language", () => {
    const md = "before\n```\nline 1\nline 2\n```\nafter";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "before\n<pre><code>line 1\nline 2</code></pre>\nafter",
    );
  });

  it("renders fenced code blocks with a language class", () => {
    const md = "```python\nprint('hi')\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      '<pre><code class="language-python">print(\'hi\')</code></pre>',
    );
  });

  it("escapes HTML inside fenced code blocks", () => {
    const md = "```\nif (a < b && c > 0) {}\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<pre><code>if (a &lt; b &amp;&amp; c &gt; 0) {}</code></pre>",
    );
  });

  it("does not interpret markdown inside fenced code blocks", () => {
    const md = "```\n**not bold** _not italic_\n```";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<pre><code>**not bold** _not italic_</code></pre>",
    );
  });

  it("renders headings as bold", () => {
    expect(convertMarkdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(convertMarkdownToTelegramHtml("### Subsection")).toBe(
      "<b>Subsection</b>",
    );
  });

  it("renders a safe http/https link as <a>", () => {
    expect(
      convertMarkdownToTelegramHtml("see [docs](https://example.com/x)"),
    ).toBe('see <a href="https://example.com/x">docs</a>');
  });

  it("renders a tg:// mention link as <a>", () => {
    expect(
      convertMarkdownToTelegramHtml("hi [me](tg://user?id=42)"),
    ).toBe('hi <a href="tg://user?id=42">me</a>');
  });

  it("rejects unsafe schemes by degrading to escaped plain text", () => {
    expect(
      convertMarkdownToTelegramHtml("[click](javascript:alert(1))"),
    ).toBe("click (javascript:alert(1))");
  });

  it("escapes <,>,& inside link href attributes", () => {
    expect(
      convertMarkdownToTelegramHtml("[x](https://e.com/?a=1&b=2)"),
    ).toBe('<a href="https://e.com/?a=1&amp;b=2">x</a>');
  });

  it("renders unordered list items with bullets", () => {
    const md = "- first\n- second\n- third";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "• first\n• second\n• third",
    );
  });

  it("renders ordered list items with bullets (Telegram has no <ol>)", () => {
    const md = "1. first\n2. second\n3. third";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "• first\n• second\n• third",
    );
  });

  it("renders a blockquote", () => {
    const md = "> quoted line one\n> quoted line two";
    expect(convertMarkdownToTelegramHtml(md)).toBe(
      "<blockquote>quoted line one\nquoted line two</blockquote>",
    );
  });

  it("composes bold + italic + link in one pass", () => {
    const md = "**Important**: read the [_guide_](https://x.com/g).";
    const out = convertMarkdownToTelegramHtml(md);
    expect(out).toBe(
      '<b>Important</b>: read the <a href="https://x.com/g"><i>guide</i></a>.',
    );
  });

  it("survives stray < and > in regular prose without producing tags", () => {
    expect(convertMarkdownToTelegramHtml("use <unknown> tags")).toBe(
      "use &lt;unknown&gt; tags",
    );
  });

  it("preserves emitted tags untouched while escaping interleaved <,>,&", () => {
    expect(
      convertMarkdownToTelegramHtml("**bold** and a < b"),
    ).toBe("<b>bold</b> and a &lt; b");
  });

  it("strips heading trailing-hash markers", () => {
    expect(convertMarkdownToTelegramHtml("## Title ##")).toBe("<b>Title</b>");
  });
});
