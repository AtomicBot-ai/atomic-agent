import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { OnboardingProposeStep } from "./onboarding-propose-step.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("OnboardingProposeStep", () => {
  it("offers local to a cloud operator, and says what it buys them", () => {
    const view = render(
      <OnboardingProposeStep offer="local" configuredLabel="Cloud model ready" cursor={0} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Cloud model ready");
    expect(frame).toContain("Set up local models too");
    expect(frame).toContain("offline");
    expect(frame).toContain("Skip");
  });

  it("mirrors for a local operator", () => {
    const view = render(
      <OnboardingProposeStep offer="cloud" configuredLabel="Local model ready" cursor={0} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Local model ready");
    expect(frame).toContain("Set up a cloud model too");
  });

  it("points the cursor at the row it is on", () => {
    const view = render(
      <OnboardingProposeStep offer="local" configuredLabel="Cloud model ready" cursor={1} />,
    );
    const lines = strip(view.lastFrame() ?? "").split("\n");
    const skip = lines.find((line) => line.includes("Skip"));
    expect(skip?.trimStart().startsWith("\u203a")).toBe(true);
  });
});
