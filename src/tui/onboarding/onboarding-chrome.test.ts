import { describe, expect, it } from "vitest";
import { onboardingFooterFor } from "./onboarding-chrome.js";
import { createOnboardingState, type OnboardingStep } from "./onboarding-state.js";

function at(step: OnboardingStep) {
  return { ...createOnboardingState("http://127.0.0.1:8080"), step };
}

describe("onboardingFooterFor", () => {
  it("advertises both ways off the download screen", () => {
    const footer = onboardingFooterFor(at("local_download"), false, null);
    expect(footer).toContain("c set up cloud meanwhile");
    expect(footer).toContain("s skip");
    expect(footer).toContain("ctrl+c quit");
  });

  it("keeps s off the almost-there screen, whose rows own their own exits", () => {
    const footer = onboardingFooterFor(at("wait_or_jump"), false, null);
    expect(footer).not.toContain("s skip");
    expect(footer).toContain("enter start or add a provider");
  });
});
