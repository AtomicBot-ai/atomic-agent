import { describe, expect, it } from "vitest";

import { DEFAULT_REWRITER_EXEMPLARS } from "./default-rewriter-exemplars.js";

describe("DEFAULT_REWRITER_EXEMPLARS", () => {
  it("ships a non-empty curated list", () => {
    expect(DEFAULT_REWRITER_EXEMPLARS.length).toBeGreaterThanOrEqual(18);
  });

  it("every entry is a non-empty trimmed string", () => {
    for (const line of DEFAULT_REWRITER_EXEMPLARS) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).toBe(line.trim());
    }
  });
});
