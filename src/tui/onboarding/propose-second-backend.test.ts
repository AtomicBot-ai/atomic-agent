import { describe, expect, it } from "vitest";
import { decideSecondBackendOffer, isLocalSetupStep } from "./propose-second-backend.js";
import type { OnboardingStep } from "./onboarding-state.js";

const base = {
  outcome: "cloud" as const,
  cloudReady: true,
  localReady: false,
  alreadyProposed: false,
  localSetupSeen: false,
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

  it("does not pitch local to someone who opened the list and backed out", () => {
    expect(decideSecondBackendOffer({ ...base, localSetupSeen: true })).toBeNull();
  });

  it("still pitches local to someone who never opened the list", () => {
    expect(decideSecondBackendOffer({ ...base, localSetupSeen: false })).toBe("local");
  });

  it("still pitches cloud to a local operator, who has seen the list by definition", () => {
    expect(
      decideSecondBackendOffer({
        ...base,
        outcome: "local",
        cloudReady: false,
        localReady: true,
        localSetupSeen: true,
      }),
    ).toBe("cloud");
  });
});

describe("isLocalSetupStep", () => {
  const cases: readonly (readonly [OnboardingStep, boolean])[] = [
    ["intro", false],
    ["choose", false],
    ["local_pick", true],
    ["local_download", true],
    ["cloud", false],
    ["custom_chat_url", false],
    ["custom_embedding_url", false],
    ["propose_second", false],
    ["wait_or_jump", true],
    ["finished", false],
  ];

  for (const [step, expected] of cases) {
    it(`${step} ${expected ? "counts as" : "is not"} a visit to the local branch`, () => {
      expect(isLocalSetupStep(step)).toBe(expected);
    });
  }
});
