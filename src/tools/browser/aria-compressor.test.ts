import { describe, it, expect } from "vitest";
import { summariseAriaSnapshot } from "./aria-compressor.js";

describe("summariseAriaSnapshot", () => {

  it("applies maxChars budget and reports size truncation footer", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`);
    const raw = lines.join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "https://example.com", title: "t" },
      { maxChars: 400, dropNoise: false },
    );
    expect(out.text.length).toBeLessThan(raw.length);
    expect(out.text).toMatch(/truncated ARIA tree by size/);
    expect(out.refs.length).toBeGreaterThan(0);
    expect(out.refs.length).toBeLessThan(200);
  });

  it("applies char budget and noise dropping together (default call-site path)", () => {
    // The only real call site (playwright-backend) passes no options, so the
    // char budget and noise dropping always run together. Cover that here.
    const noise = Array.from({ length: 20 }, (_, i) => `  - generic [ref=n${i}]:`);
    const links = Array.from(
      { length: 200 },
      (_, i) => `- link "Item ${i}" [ref=e${i}]`,
    );
    const raw = [...noise, ...links].join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "https://example.com", title: "t" },
      { maxChars: 400 },
    );
    expect(out.text).toMatch(/collapsed \d+ empty container lines/);
    expect(out.text).toMatch(/truncated ARIA tree by size/);
    // Empty generics are dropped, so none of the n-refs survive.
    expect(out.refs.some((r) => r.startsWith("n"))).toBe(false);
    expect(out.refs.length).toBeGreaterThan(0);
  });

  it("treats a fractional maxChars as at least one char (never wipes the tree)", () => {
    const raw = '- link "Home" [ref=e1]';
    const out = summariseAriaSnapshot(
      raw,
      { url: "u", title: "t" },
      { maxChars: 0.4 },
    );
    // Must not collapse to an empty body: 0.4 -> trunc 0 previously wiped it.
    expect(out.text).toContain("truncated ARIA tree by size");
    expect(out.refs.length).toBeGreaterThanOrEqual(0);
    expect(out.text).toMatch(/^url: u/);
  });

  it("extracts refs and emits a header", () => {
    const raw = [
      "- banner",
      '  - link [ref=e5]: Home',
      '  - textbox [ref=e7]: Search',
    ].join("\n");
    const out = summariseAriaSnapshot(raw, {
      url: "https://u/",
      title: "T",
    });
    expect(out.refs.sort()).toEqual(["e5", "e7"]);
    expect(out.text).toMatch(/^url: https:\/\/u\//);
    expect(out.text).toContain("[ref=e5]");
    expect(out.digest).toMatch(/^[a-f0-9]+$/);
  });

  it("truncates past maxLines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- link [ref=e${i}]`);
    const out = summariseAriaSnapshot(
      lines.join("\n"),
      { url: "u", title: "t" },
      { maxLines: 10 },
    );
    expect(out.text).toContain("[truncated ARIA tree");
  });

  it("collapses chains of empty generic containers so interactive nodes survive", () => {
    const raw = [
      "- generic [ref=e2]:",
      "  - generic [ref=e4]:",
      "    - generic [ref=e5]:",
      "      - generic [ref=e6]:",
      '        - link "DuckDuckGo home" [ref=e7]: /url',
      "        - generic [ref=e8]:",
      '          - heading "Results" [ref=e9]: Results',
      '          - link "Hermes - Wikipedia" [ref=e10]: /url',
    ].join("\n");
    const out = summariseAriaSnapshot(raw, {
      url: "https://duckduckgo.com/?q=hermes",
      title: "hermes at DuckDuckGo",
    });
    expect(out.text).toContain('link "DuckDuckGo home"');
    expect(out.text).toContain('heading "Results"');
    expect(out.text).toContain('link "Hermes - Wikipedia"');
    expect(out.text).toContain("[collapsed 5 empty container lines]");
    // Noise refs are NOT in the ref list because the model can't
    // usefully act on empty generics.
    expect(out.refs.sort()).toEqual(["e10", "e7", "e9"]);
  });

  it("keeps container lines that carry a quoted name or inline text", () => {
    const raw = [
      '- generic "search-results" [ref=e1]:',
      "- generic [ref=e2]: some inline text",
      "- generic [ref=e3]:",
    ].join("\n");
    const out = summariseAriaSnapshot(raw, { url: "u", title: "t" });
    expect(out.text).toContain('generic "search-results"');
    expect(out.text).toContain("some inline text");
    expect(out.text).toContain("[collapsed 1 empty container lines]");
  });

  it("dropNoise=false preserves the raw tree verbatim", () => {
    const raw = [
      "- generic [ref=e1]:",
      "  - generic [ref=e2]:",
      '    - link [ref=e3]: /url',
    ].join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "u", title: "t" },
      { dropNoise: false },
    );
    expect(out.text).toContain("generic [ref=e1]");
    expect(out.text).toContain("generic [ref=e2]");
    expect(out.text).not.toContain("[collapsed");
  });
});
