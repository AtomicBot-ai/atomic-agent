import { beforeEach, describe, expect, it, vi } from "vitest";
import { highlightCodeBlock } from "./syntax-highlight.js";

const cli = vi.hoisted(() => ({
  highlight: vi.fn((code: string) => `<cli>${code}</cli>`),
  supportsLanguage: vi.fn((lang: string) => lang !== "nope"),
}));
const shiki = vi.hoisted(() => ({
  highlightWithShiki: vi.fn((): string | null => null),
}));

vi.mock("cli-highlight", () => cli);
vi.mock("./shiki-highlighter.js", () => shiki);

beforeEach(() => {
  cli.highlight.mockClear();
  shiki.highlightWithShiki.mockReset();
  shiki.highlightWithShiki.mockReturnValue(null);
});

describe("highlightCodeBlock fallbacks", () => {
  it("uses shiki for a bundled language and skips cli-highlight", () => {
    shiki.highlightWithShiki.mockReturnValue("<shiki>");
    expect(highlightCodeBlock("let a = 1;", "TS")).toBe("<shiki>");
    expect(shiki.highlightWithShiki).toHaveBeenCalledWith(
      "let a = 1;",
      "typescript",
    );
    expect(cli.highlight).not.toHaveBeenCalled();
  });

  it("falls back to cli-highlight when shiki returns null", () => {
    expect(highlightCodeBlock("let a = 1;", "ts")).toBe("<cli>let a = 1;</cli>");
  });

  it("sends a language outside the bundled set straight to cli-highlight", () => {
    expect(highlightCodeBlock("class A {}", "java")).toBe("<cli>class A {}</cli>");
    expect(shiki.highlightWithShiki).not.toHaveBeenCalled();
  });

  it("returns raw text when cli-highlight throws", () => {
    cli.highlight.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(highlightCodeBlock("class A {}", "java")).toBe("class A {}");
  });

  it("returns raw text when neither highlighter supports the language", () => {
    expect(highlightCodeBlock("x", "nope")).toBe("x");
  });
});
