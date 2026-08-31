import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown-renderer.js";

function strip(output: string): string {
  // strip ANSI escape codes for golden comparison
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

describe("MarkdownRenderer", () => {
  it("renders bold, italic and inline code", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text="**bold** _it_ `code`" />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("bold");
    expect(text).toContain("it");
    expect(text).toContain("code");
  });

  it("renders headings without literal hash markers", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"# Title\n\nbody"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Title");
    expect(text).not.toContain("# Title");
    expect(text).toContain("body");
  });

  it("renders fenced code blocks with fence markers", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"```ts\nconst x = 1;\n```"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("```");
    expect(text).toContain("const x = 1;");
  });

  it("renders links with the label", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text="[cursor](https://cursor.com)" />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("cursor");
    expect(text).toContain("https://cursor.com");
  });

  it("wraps markdown links in OSC8 while keeping the URL visible as a terminal fallback", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text="[cursor](https://cursor.com)" />,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain("\u001b]8;;https://cursor.com\u001b\\cursor\u001b]8;;\u001b\\");
    expect(text).toContain("(https://cursor.com)");
  });

  it("wraps a bare URL in OSC8 so it is clickable across terminals", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text="see https://cursor.com for docs" />,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain(
      "\u001b]8;;https://cursor.com\u001b\\https://cursor.com\u001b]8;;\u001b\\",
    );
  });

  it("linkifies a bare URL the GFM autolinker misses (non-ASCII host)", () => {
    // marked leaves `https://пример.рф` as a plain `text` token — the
    // GFM url rule only matches ASCII hosts — so this pins the
    // splitUrlSegments fallback on the inline `text` path.
    const { lastFrame } = render(
      <MarkdownRenderer text="откройте https://пример.рф сейчас" />,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain(
      "\u001b]8;;https://пример.рф\u001b\\https://пример.рф\u001b]8;;\u001b\\",
    );
  });

  it("does not linkify a URL inside a codespan", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text="run `https://cursor.com` verbatim" />,
    );
    const text = lastFrame() ?? "";
    expect(strip(text)).toContain("https://cursor.com");
    expect(text).not.toContain("\u001b]8;;");
  });

  it("does not linkify a URL inside a fenced code block", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"```\ncurl https://cursor.com\n```"} />,
    );
    const text = lastFrame() ?? "";
    expect(strip(text)).toContain("https://cursor.com");
    expect(text).not.toContain("\u001b]8;;");
  });

  it("renders bulleted lists with a bullet glyph", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"- first\n- second"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  it("renders nested lists indented under their parent item", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"- parent\n  - child"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("parent");
    expect(text).toContain("child");
    const childLine = text.split("\n").find((l) => l.includes("child")) ?? "";
    const parentLine = text.split("\n").find((l) => l.includes("parent")) ?? "";
    expect(childLine.indexOf("child")).toBeGreaterThan(
      parentLine.indexOf("parent"),
    );
  });

  it("renders a GFM table as an aligned grid instead of raw pipes", () => {
    const { lastFrame } = render(
      <MarkdownRenderer
        text={"| Metric | 2026 |\n|--------|------|\n| GDP | 0.9 |"}
      />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Metric");
    expect(text).toContain("GDP");
    expect(text).toContain("0.9");
    // Column divider is the box-drawing glyph, not the raw markdown
    // separator row.
    expect(text).toContain("│");
    expect(text).not.toContain("|--------|");
  });
});
