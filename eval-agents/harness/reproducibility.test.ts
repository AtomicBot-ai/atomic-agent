import { describe, expect, it } from "vitest";

import { questionScorer } from "./score-gaia.js";

/**
 * Scoring path must be deterministic — two identical inputs always match.
 * Full ±1pp campaign lock requires duplicate LLM runs (see run-smoke).
 */
describe("GAIA scorer reproducibility", () => {
  it("returns identical results on repeated calls", () => {
    const pairs: Array<[string, string]> = [
      ["42", "42"],
      ["$1,250", "1250"],
      ["Oslo", "Oslo"],
      ["red, blue", "red, blue"],
    ];
    for (const [pred, gold] of pairs) {
      const a = questionScorer(pred, gold);
      const b = questionScorer(pred, gold);
      expect(a).toBe(b);
    }
  });
});
