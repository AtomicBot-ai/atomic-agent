import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { byteEstimateCounter, estimateTokensFromBytes } from "./token-counter.js";

describe("cloud byte estimate (ATO-656)", () => {
  it("is ceil(utf8 bytes / 4)", async () => {
    expect(estimateTokensFromBytes("12345678")).toBe(2);
    expect(estimateTokensFromBytes("123456789")).toBe(3);
    expect(estimateTokensFromBytes("")).toBe(0);
    // Two bytes per Cyrillic letter: 4 letters = 8 bytes = 2 tokens.
    expect(estimateTokensFromBytes("тест")).toBe(2);
    expect(await byteEstimateCounter.count("12345678")).toBe(2);
  });

  it("ships no tokenizer dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain("gpt-tokenizer");
    }
  });
});
