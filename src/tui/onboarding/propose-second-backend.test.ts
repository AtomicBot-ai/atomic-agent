import { describe, expect, it } from "vitest";
import { decideSecondBackendOffer } from "./propose-second-backend.js";

const base = {
  outcome: "cloud" as const,
  cloudReady: true,
  localReady: false,
  alreadyProposed: false,
};

describe("decideSecondBackendOffer", () => {
  it("offers local to someone who just configured cloud", () => {
    expect(decideSecondBackendOffer(base)).toBe("local");
  });

  it("offers cloud to someone who just downloaded a local model", () => {
    expect(
      decideSecondBackendOffer({
        ...base,
        outcome: "local",
        cloudReady: false,
        localReady: true,
      }),
    ).toBe("cloud");
  });

  it("says nothing when both backends are already configured", () => {
    expect(
      decideSecondBackendOffer({ ...base, outcome: "local", localReady: true }),
    ).toBeNull();
  });

  it("never follows a custom endpoint — that operator has answered already", () => {
    expect(
      decideSecondBackendOffer({ ...base, outcome: "custom", cloudReady: false }),
    ).toBeNull();
  });

  it("never follows a skip", () => {
    expect(
      decideSecondBackendOffer({ ...base, outcome: "skipped", cloudReady: false }),
    ).toBeNull();
  });

  it("is offered once and never again", () => {
    expect(decideSecondBackendOffer({ ...base, alreadyProposed: true })).toBeNull();
  });
});
