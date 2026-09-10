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

  it("names the missing local leg", () => {
    expect(
      describeRunModeDegradation({
        reason: "no-local-provider",
        requested: "fusion",
      }),
    ).toMatch(/needs local workers.*Running cloud-only/);
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
