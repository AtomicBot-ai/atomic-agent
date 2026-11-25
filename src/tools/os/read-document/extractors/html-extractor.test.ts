import { describe, expect, it } from "vitest";

import { htmlExtractor } from "./html-extractor.js";

const run = (html: string | Buffer) =>
  htmlExtractor({
    data: typeof html === "string" ? Buffer.from(html, "utf8") : html,
    sourcePath: "page.html",
  });

describe("htmlExtractor", () => {
  it("renders the body as markdown and drops scripts, styles and head", async () => {
    const result = await run(
      `<!doctype html><html><head><title>Report</title><style>.x{}</style><script>alert(1)</script></head>` +
        `<body><h2>Results</h2><p>See <a href="https://example.com">the site</a>.</p>` +
        `<script>track()</script><ol><li>first</li></ol></body></html>`,
    );
    expect(result.format).toBe("html");
    expect(result.text.startsWith("# Report\n\n## Results")).toBe(true);
    expect(result.text).toContain("[the site](https://example.com)");
    expect(result.text).toContain("1.  first");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("track()");
    expect(result.text).not.toContain(".x{}");
    expect(result.warnings).toEqual([]);
  });

  it("keeps tables as pipe rows", async () => {
    const result = await run(
      "<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr></tbody></table>",
    );
    expect(result.text).toBe("| Item | Qty |\n| --- | --- |\n| Apple | 3 |");
  });

  it("honours a declared legacy charset", async () => {
    const head = Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>', "latin1");
    const word = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    const tail = Buffer.from("</p></body></html>", "latin1");
    const result = await run(Buffer.concat([head, word, tail]));
    expect(result.text).toBe("Привет");
  });

  it("does not repeat the title when the body already opens with it", async () => {
    const result = await run("<html><head><title>Same</title></head><body><h1>Same</h1><p>x</p></body></html>");
    expect(result.text).toBe("# Same\n\nx");
  });
});
