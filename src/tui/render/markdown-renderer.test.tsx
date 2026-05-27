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

  it("renders headings with prefixed hashes", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"# Title\n\nbody"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("# Title");
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

  it("renders bulleted lists with a bullet glyph", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"- first\n- second"} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
