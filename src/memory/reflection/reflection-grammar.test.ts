import { describe, expect, it } from "vitest";

import { REFLECTION_GRAMMAR } from "./reflection-grammar.js";

describe("REFLECTION_GRAMMAR", () => {
  it("exposes a non-empty string", () => {
    expect(typeof REFLECTION_GRAMMAR).toBe("string");
    expect(REFLECTION_GRAMMAR.length).toBeGreaterThan(0);
  });

  it("is byte-stable across imports (participates in the slot prefix cache)", () => {
    const first = REFLECTION_GRAMMAR;
    const second = REFLECTION_GRAMMAR;
    expect(first).toBe(second);
  });

  it("defines the NONE alternative and both SET and NOTE productions", () => {
    expect(REFLECTION_GRAMMAR).toContain("root");
    expect(REFLECTION_GRAMMAR).toContain('"NONE"');
    expect(REFLECTION_GRAMMAR).toContain('"SET "');
    expect(REFLECTION_GRAMMAR).toContain('"NOTE "');
    expect(REFLECTION_GRAMMAR).toContain("key");
    expect(REFLECTION_GRAMMAR).toContain("value");
    expect(REFLECTION_GRAMMAR).toContain("body");
  });

  it("routes the top level through entry = set | note", () => {
    expect(REFLECTION_GRAMMAR).toMatch(/entry\s*::=\s*set\s*\|\s*note/);
  });

  it("caps SET values at 200 characters", () => {
    expect(REFLECTION_GRAMMAR).toMatch(/value\s*::=\s*\[\^\\n\]\{1,200\}/);
  });

  it("caps NOTE body at 500 characters", () => {
    expect(REFLECTION_GRAMMAR).toMatch(/body\s*::=\s*\[\^\\n\]\{1,500\}/);
  });

  it("caps keys at snake_case 32 characters", () => {
    expect(REFLECTION_GRAMMAR).toMatch(
      /key\s*::=\s*\[a-z\]\s*\[a-z0-9_\]\{0,31\}/,
    );
  });

  it("phase C: accepts an optional [type=X] marker on NOTE", () => {
    // Marker is optional (`typemark?`) so legacy untyped NOTEs from
    // older sessions remain grammatically valid. The four canonical
    // type values mirror `NOTE_TYPES` in reflection-grammar.ts.
    expect(REFLECTION_GRAMMAR).toMatch(/typemark\?/);
    expect(REFLECTION_GRAMMAR).toMatch(/typemark\s*::=\s*"\[type="/);
    expect(REFLECTION_GRAMMAR).toMatch(/"event"/);
    expect(REFLECTION_GRAMMAR).toMatch(/"behavior"/);
    expect(REFLECTION_GRAMMAR).toMatch(/"knowledge"/);
    expect(REFLECTION_GRAMMAR).toMatch(/"skill"/);
  });
});
