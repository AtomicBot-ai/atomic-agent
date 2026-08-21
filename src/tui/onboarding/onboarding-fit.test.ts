import { describe, expect, it } from "vitest";
import { computeOnboardingFit } from "./onboarding-fit.js";

describe("computeOnboardingFit", () => {
  it("draws everything at 100×30 and says nothing about the size", () => {
    expect(computeOnboardingFit({ columns: 100, rows: 30 })).toEqual({
      tier: "full",
      mark: true,
      explainer: true,
      rowDetails: true,
      sizeAdvice: false,
    });
  });

  it("advises — never blocks — below the full size", () => {
    const fit = computeOnboardingFit({ columns: 86, rows: 26 });
    expect(fit.tier).toBe("reduced");
    expect(fit.sizeAdvice).toBe(true);
    expect(fit.mark).toBe(true);
  });

  it("drops row details when the columns cannot carry them", () => {
    expect(computeOnboardingFit({ columns: 80, rows: 26 }).rowDetails).toBe(false);
    expect(computeOnboardingFit({ columns: 90, rows: 26 }).rowDetails).toBe(true);
  });

  it("drops the explainer when rows are tight", () => {
    expect(computeOnboardingFit({ columns: 90, rows: 20 }).explainer).toBe(false);
  });

  it("sheds the mark on a genuinely tiny terminal, and still advises", () => {
    const fit = computeOnboardingFit({ columns: 60, rows: 14 });
    expect(fit.tier).toBe("minimal");
    expect(fit.mark).toBe(false);
    expect(fit.sizeAdvice).toBe(true);
  });
});
