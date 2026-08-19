import { describe, expect, it } from "vitest";

import { describeRunModeDegradation } from "./run-mode-degradation.js";

describe("describeRunModeDegradation", () => {
  it("names the orchestrator when fusion has no cloud leg", () => {
    const msg = describeRunModeDegradation({
      reason: "no-cloud-provider",
      requested: "fusion",
    });
    expect(msg).toContain("Fusion needs a cloud orchestrator");
    expect(msg).toContain("Staying on local");
  });

  it("uses the plain cloud wording when cloud mode has no cloud leg", () => {
    const msg = describeRunModeDegradation({
      reason: "no-cloud-provider",
      requested: "cloud",
    });
    expect(msg).toContain("Cloud mode needs a cloud provider");
    expect(msg).not.toContain("Fusion");
  });

  it("names the executor when fusion has no local leg", () => {
    expect(
      describeRunModeDegradation({ reason: "no-local-provider", requested: "fusion" }),
    ).toContain("Fusion needs a local executor");
  });

  it("explains a pinned tool transport as a warning, not a downgrade", () => {
    const msg = describeRunModeDegradation({
      reason: "tool-transport-pinned",
      requested: "fusion",
    });
    expect(msg).toContain("llm.toolTransport");
    expect(msg).not.toContain("Staying on local");
  });

  it("points every degradation at a way to fix it", () => {
    expect(
      describeRunModeDegradation({ reason: "no-cloud-provider", requested: "cloud" }),
    ).toContain("/llm");
  });
});
