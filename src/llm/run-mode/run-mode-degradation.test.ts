import { describe, expect, it } from "vitest";

import { describeRunModeDegradation } from "./run-mode-degradation.js";

describe("describeRunModeDegradation", () => {
  it("names the missing cloud leg for fusion and for cloud mode differently", () => {
    expect(
      describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested: "fusion",
      }),
    ).toMatch(/^Fusion needs a cloud orchestrator/);
    expect(
      describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested: "cloud",
      }),
    ).toMatch(/^Cloud mode needs a cloud provider/);
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

  it("always points at where to fix it", () => {
    expect(
      describeRunModeDegradation({
        reason: "no-cloud-provider",
        requested: "fusion",
      }),
    ).toContain("Manage → LLM → Cloud");
  });
});
