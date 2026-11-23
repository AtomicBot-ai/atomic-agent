import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import {
  CHAT_EXPORT_HINT,
  measureOnboardingImportPickStep,
  OnboardingImportPickStep,
} from "./onboarding-import-step.js";

const AGENTS = [{ id: "hermes" as const, label: "Hermes", dir: "~/.hermes", enabled: false }];

describe("first-run import: ChatGPT / Claude export hint (ATO-1062)", () => {
  it("points a ChatGPT or Claude user at the facts step", () => {
    const { lastFrame } = render(
      <OnboardingImportPickStep agents={AGENTS} cursor={0} busy={false} error={null} />,
    );
    expect(lastFrame()).toContain("From ChatGPT or Claude?");
    expect(lastFrame()).toContain("/import › Facts about you");
  });

  it("the block is measured wide enough for the hint", () => {
    expect(measureOnboardingImportPickStep(AGENTS)).toBeGreaterThanOrEqual(CHAT_EXPORT_HINT.length);
  });
});
