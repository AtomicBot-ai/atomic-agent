import { describe, expect, it } from "vitest";

import {
  checkHtmlSource,
  extractInlineScripts,
  HTML_CHECKER,
  trailingContentWarning,
} from "./check-html-syntax.js";

describe("extractInlineScripts", () => {
  it("keeps inline JS blocks, skips external and non-JS ones, and records the line", () => {
    const html = [
      "<html><head>",
      '<script src="lib.js"></script>',
      '<script type="text/template"><div>{{x}}</div></script>',
      "<script>",
      "var a = 1;",
      "</script>",
      '<script type="module">export const b = 2;</script>',
      "</head></html>",
    ].join("\n");
    const { scripts, external } = extractInlineScripts(html);
    expect(external).toBe(1);
    expect(scripts.map((s) => [s.index, s.line, s.module])).toEqual([
      [3, 4, false],
      [4, 7, true],
    ]);
    expect(scripts[0]?.code.trim()).toBe("var a = 1;");
  });
});

describe("trailingContentWarning", () => {
  it("is silent for whitespace after </html> and for fragments without it", () => {
    expect(trailingContentWarning("<html></html>\n\n")).toBeNull();
    expect(trailingContentWarning("<div>fragment</div>")).toBeNull();
  });

  it("names content after the closing tag", () => {
    const warning = trailingContentWarning(
      "<html></html>\n```\nleftover text\n```",
    );
    expect(warning).toContain("content after </html>");
    expect(warning).toContain("leftover text");
  });
});

describe("checkHtmlSource", () => {
  it("passes a page whose inline scripts parse", async () => {
    const out = await checkHtmlSource(
      "index.html",
      "<html><body><script>const x = {a: 1};\n</script></body></html>",
    );
    expect(out).toEqual({ file: "index.html", ok: true, checker: HTML_CHECKER });
  });

  it("fails on the block with the error, with the line rebased onto the document", async () => {
    const html = [
      "<html><body>",
      "<script>",
      "var ok = 1;",
      "</script>",
      "<script>",
      "function broken( {",
      "</script>",
      "</body></html>",
    ].join("\n");
    const out = await checkHtmlSource("index.html", html);
    expect(out.ok).toBe(false);
    // The label carries the `<script>` tag's line; the parser's own
    // "(line N)" is rebased onto the document (end of input at `</script>`).
    expect(out.error).toContain("inline script #2 (line 5)");
    expect(out.error).toMatch(/SyntaxError: .* \(line 7\)/);
  });

  it("checks an inline ES module through node --check rather than skipping it", async () => {
    const html =
      '<html><body><script type="module">import { a } from "./a.js";\nconst b = ;\n</script></body></html>';
    const out = await checkHtmlSource("index.html", html);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/SyntaxError/);
  });

  it("gives no verdict for a page with no inline script, and never a pass", async () => {
    const out = await checkHtmlSource(
      "index.html",
      '<html><body><script src="game.js"></script></body></html>',
    );
    expect(out.ok).toBeNull();
    expect(out.error).toBe("no inline scripts to check (1 external)");
  });

  it("attaches the trailing-content warning without changing the verdict", async () => {
    const out = await checkHtmlSource(
      "index.html",
      "<html><body><script>var a = 1;</script></body></html>\nstray",
    );
    expect(out.ok).toBe(true);
    expect(out.warning).toContain("content after </html>");
  });
});
