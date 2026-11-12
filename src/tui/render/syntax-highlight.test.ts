import { afterEach, describe, expect, it } from "vitest";
import { THEMES, setActiveTheme } from "../theme/theme.js";
import {
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
  resetShikiHighlighterForTests,
  shikiThemeForActivePalette,
} from "./shiki-highlighter.js";
import { MAX_HIGHLIGHT_LENGTH, highlightCodeBlock } from "./syntax-highlight.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

afterEach(() => {
  setActiveTheme(THEMES["classic-dark"]);
  resetShikiHighlighterForTests();
});

describe("highlightCodeBlock", () => {
  it.each([
    ["ts", "const x: number = 1;\nexport type A = { b: string };"],
    ["tsx", "export const App = () => <div className=\"a\">{x}</div>;"],
    ["rust", "fn main() {\n    let v: Vec<u8> = Vec::new();\n}"],
    ["go", "package main\n\nfunc main() { fmt.Println(\"hi\") }"],
    ["yaml", "name: ci\non:\n  push: {}"],
    ["toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\""],
    ["json", "{ \"a\": 1, \"b\": [true, null] }"],
    ["bash", "if [ -f x ]; then echo \"ok\"; fi"],
  ])("colours %s through the bundled grammars", (lang, code) => {
    const out = highlightCodeBlock(code, lang);
    expect(out).toMatch(ANSI);
    expect(strip(out)).toBe(code);
  });

  it("keeps one line of output per line of input", () => {
    const code = "const a = 1;\n\nconst b = `x`;\n";
    const out = highlightCodeBlock(code, "ts");
    expect(out.split("\n")).toHaveLength(code.split("\n").length);
    expect(strip(out)).toBe(code);
  });

  it("closes every colour on the line it opens, so lines render alone", () => {
    const out = highlightCodeBlock("/* a\n b */ const c = 1;", "ts");
    for (const line of out.split("\n")) {
      const opens = (line.match(/\u001b\[38;[25];[0-9;]+m/g) ?? []).length;
      const closes = (line.match(/\u001b\[39m/g) ?? []).length;
      expect(closes).toBe(opens);
    }
  });

  it("returns the input untouched when it is empty or has no language", () => {
    expect(highlightCodeBlock("", "ts")).toBe("");
    expect(highlightCodeBlock("npm test", "")).toBe("npm test");
    expect(highlightCodeBlock("npm test", "   ")).toBe("npm test");
  });

  it("leaves a snippet over the size cap as raw text", () => {
    const code = "x".repeat(MAX_HIGHLIGHT_LENGTH + 1);
    expect(highlightCodeBlock(code, "ts")).toBe(code);
  });

  it("leaves a language neither highlighter knows as raw text", () => {
    expect(highlightCodeBlock("blorp 1 2", "not-a-language")).toBe(
      "blorp 1 2",
    );
  });

  it("reuses the cached result when the same block is drawn again", () => {
    const code = "let a = 1;";
    expect(highlightCodeBlock(code, "ts")).toBe(highlightCodeBlock(code, "ts"));
  });
});

describe("shikiThemeForActivePalette", () => {
  it("uses dark-plus on dark palettes and light-plus on classic-light", () => {
    setActiveTheme(THEMES["classic-dark"]);
    expect(shikiThemeForActivePalette()).toBe(SHIKI_DARK_THEME);
    setActiveTheme(THEMES["classic-light"]);
    expect(shikiThemeForActivePalette()).toBe(SHIKI_LIGHT_THEME);
  });

  it("colours the same code differently on light and dark palettes", () => {
    const code = "const s = \"hi\";";
    const dark = highlightCodeBlock(code, "ts");
    setActiveTheme(THEMES["classic-light"]);
    const light = highlightCodeBlock(code, "ts");
    expect(light).not.toBe(dark);
    expect(strip(light)).toBe(strip(dark));
  });
});
