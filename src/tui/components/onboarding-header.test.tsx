import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import { OnboardingHeader } from "./onboarding-header.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("OnboardingHeader", () => {
  it("draws the XS sign — not a bare wordmark — on a tiny terminal", () => {
    // 60×14 is below both minimal thresholds; the tier used to shed
    // the mark entirely here.
    const fit = computeOnboardingFit({ columns: 60, rows: 14 });
    expect(fit.mark).toBe("xs");
    const { lastFrame } = render(
      <OnboardingHeader subtitle="step 1 of 3" mark={fit.mark} />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("▗█▄░");
    expect(frame).toContain("▀█▘░");
    expect(frame).toContain("atomic");
    expect(frame).toContain("step 1 of 3");
  });

  it("keeps the three-row SM mark at roomier tiers", () => {
    const { lastFrame } = render(
      <OnboardingHeader subtitle="pick a backend" mark="sm" />,
    );
    const frame = strip(lastFrame() ?? "");
    // SM's middle bar — five face cells — only exists at three rows.
    expect(frame).toContain("█████");
    expect(frame).toContain("atomic");
  });
});
