import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_PROFILE_NAMES,
  PROFILE_PROMPT_BUDGETS_MS,
  getProfilePromptBudgetMs,
  type CampaignProfileName,
} from "./campaign-profiles.js";

describe("PROFILE_PROMPT_BUDGETS_MS", () => {
  it("covers every campaign profile name", () => {
    for (const name of CAMPAIGN_PROFILE_NAMES) {
      expect(PROFILE_PROMPT_BUDGETS_MS[name]).toBeGreaterThan(0);
    }
  });

  it("budgets are positive integers", () => {
    for (const name of CAMPAIGN_PROFILE_NAMES) {
      const v = PROFILE_PROMPT_BUDGETS_MS[name];
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("reflection-heavy profiles are at least 2x heavier than light profiles", () => {
    const light = PROFILE_PROMPT_BUDGETS_MS.fts5_only;
    expect(PROFILE_PROMPT_BUDGETS_MS.full_v2).toBeGreaterThanOrEqual(light * 2);
    expect(PROFILE_PROMPT_BUDGETS_MS.hybrid_plus_lessons).toBeGreaterThanOrEqual(
      light * 2,
    );
  });
});

describe("getProfilePromptBudgetMs", () => {
  it("returns the table value for known profiles", () => {
    for (const name of CAMPAIGN_PROFILE_NAMES) {
      expect(getProfilePromptBudgetMs(name)).toBe(PROFILE_PROMPT_BUDGETS_MS[name]);
    }
  });

  it("defaults to 60_000 for an unknown profile name (defensive)", () => {
    expect(
      getProfilePromptBudgetMs("never-registered" as CampaignProfileName),
    ).toBe(60_000);
  });
});
