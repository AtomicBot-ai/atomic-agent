import { describe, expect, it } from "vitest";
import {
  SHIKI_GRAMMARS,
  mappedShikiLanguages,
  resolveShikiLanguage,
} from "./shiki-languages.js";

describe("resolveShikiLanguage", () => {
  it.each([
    ["ts", "typescript"],
    ["TypeScript", "typescript"],
    ["tsx", "tsx"],
    ["jsx", "javascript"],
    ["js", "javascript"],
    ["rs", "rust"],
    ["golang", "go"],
    ["yml", "yaml"],
    ["toml", "toml"],
    ["bash", "shellscript"],
    ["dockerfile", "docker"],
    ["jsonc", "jsonc"],
    ["patch", "diff"],
  ])("maps the %s fence to %s", (fence, id) => {
    expect(resolveShikiLanguage(fence)).toBe(id);
  });

  it("ignores spaces and any info string after the language", () => {
    expect(resolveShikiLanguage("  ts  ")).toBe("typescript");
    expect(resolveShikiLanguage('ts title="a.ts"')).toBe("typescript");
  });

  it("returns undefined for an empty or unbundled language", () => {
    expect(resolveShikiLanguage("")).toBeUndefined();
    expect(resolveShikiLanguage("   ")).toBeUndefined();
    expect(resolveShikiLanguage("java")).toBeUndefined();
    expect(resolveShikiLanguage("cobol")).toBeUndefined();
  });

  it("does not resolve Object prototype keys as languages", () => {
    expect(resolveShikiLanguage("constructor")).toBeUndefined();
    expect(resolveShikiLanguage("toString")).toBeUndefined();
  });

  it("only maps to languages whose grammar is bundled", () => {
    const bundled = new Set(SHIKI_GRAMMARS.map((grammar) => grammar.name));
    for (const id of mappedShikiLanguages()) {
      expect(bundled.has(id), `grammar for ${id}`).toBe(true);
    }
  });
});
