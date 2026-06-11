import { describe, expect, it } from "vitest";

import { normalizeStr, questionScorer } from "./score-gaia.js";

describe("questionScorer", () => {
  it("scores numeric answers after stripping currency symbols", () => {
    expect(questionScorer("$1,250", "1250")).toBe(true);
  });

  it("scores string answers with whitespace and punctuation normalization", () => {
    expect(questionScorer("  Oslo. ", "Oslo")).toBe(true);
    expect(normalizeStr("sea gull")).toBe(normalizeStr("seagull"));
  });

  it("scores comma-separated lists element-wise", () => {
    expect(questionScorer("red, blue", "red, blue")).toBe(true);
    // GAIA split_string accepts both comma and semicolon delimiters
    expect(questionScorer("red; blue", "red, blue")).toBe(true);
  });

  it("rejects wrong answers", () => {
    expect(questionScorer("41", "42")).toBe(false);
  });
});
