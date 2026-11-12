import { describe, expect, it } from "vitest";

import { hfChoiceLine, hfChoiceRating } from "./hf-pick-list.js";

const base = {
  path: "Qwen3.5-4B-Q4_K_M.gguf",
  filename: "Qwen3.5-4B-Q4_K_M.gguf",
  sizeBytes: 2.7e9,
  fileSizeGb: 2.5,
  sizeLabel: "2.5 GB",
};

describe("hfChoiceRating (ATO-450)", () => {
  it("adds nothing to a list the machine did not rate", () => {
    expect(hfChoiceRating(base)).toBe("");
    expect(hfChoiceLine(base, false)).toBe(
      `   ${base.filename.padEnd(44)}${base.sizeLabel.padStart(9)}`,
    );
  });

  it("names the pick first, then the fit and the forecast", () => {
    const rated = {
      ...base,
      bits: 4,
      fit: { tier: "fits" as const, label: "Fits well" as const, placement: "gpu" as const },
      speed: { tokPerSec: 24, label: "~25 tok/s, estimate" },
      recommended: true,
    };
    expect(hfChoiceRating(rated)).toBe("  Recommended · Fits well · ~25 tok/s, estimate");
  });

  it("leaves the forecast out when there is none", () => {
    const rated = {
      ...base,
      fit: { tier: "too-big" as const, label: "Too big" as const, placement: "disk" as const },
      speed: null,
      recommended: false,
    };
    expect(hfChoiceRating(rated)).toBe("  Too big");
  });
});
