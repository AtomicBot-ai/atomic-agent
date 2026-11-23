import { describe, expect, it } from "vitest";

import { fusionLinkModel } from "./fusion-link-model.js";

describe("fusionLinkModel (ATO-1560)", () => {
  const fusion = { effective: "fusion" as const, orchestratorProviderId: "openrouter", orchestratorTurnModel: "model-big" };

  it("asks the orchestrator leg for the orchestrator model while Fusion runs", () => {
    expect(fusionLinkModel(fusion, "openrouter")).toBe("model-big");
  });

  it("leaves every other link, and every other mode, on its own model", () => {
    expect(fusionLinkModel(fusion, "groq")).toBeUndefined();
    expect(fusionLinkModel({ ...fusion, effective: "cloud" }, "openrouter")).toBeUndefined();
    expect(fusionLinkModel({ effective: "fusion", orchestratorProviderId: "openrouter" }, "openrouter")).toBeUndefined();
  });
});
