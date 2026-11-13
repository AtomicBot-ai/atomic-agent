import { describe, expect, it } from "vitest";

import { describeRunModeDegradation } from "./run-mode-degradation.js";

describe("describeRunModeDegradation", () => {
  it("names the missing cloud leg for fusion and for cloud mode differently", () => {
    expect(
      describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested: "fusion",
      }),
    ).toMatch(/^Fusion needs a cloud model/);
    expect(
      describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested: "cloud",
      }),
    ).toMatch(/^Cloud mode needs a cloud model/);
  });

  it("names the missing second leg without prescribing its kind", () => {
    // Either leg may be cloud or local; the requirement is two of them.
    const line = describeRunModeDegradation({
      reason: "no-second-provider",
      requested: "fusion",
    });
    expect(line).toMatch(/needs two providers/);
    expect(line).not.toMatch(/llama-server|local workers/);
  });

  it("says it in plain words: no em dash, no menu path, no slash command", () => {
    // The way to add a provider rides beside the line as a button
    // (ATO-1460), so the sentence carries no directions of its own.
    for (const requested of ["cloud", "fusion"] as const) {
      const line = describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested,
      });
      expect(line).not.toContain("\u2014");
      expect(line).not.toContain("Manage \u2192");
      expect(line).not.toContain("/llm");
      expect(line).toContain("answers come from the local model");
    }
  });
});
