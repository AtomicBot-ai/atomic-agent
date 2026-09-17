import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import {
  DEFAULT_REASONING_BUDGET_TOKENS,
  REASONING_CHARS_PER_TOKEN,
  estimateReasoningTokens,
  reasoningBudgetChars,
} from "./reasoning-budget.js";

describe("reasoning budget units (F49)", () => {
  it("shares its default with the config schema", () => {
    expect(DEFAULT_REASONING_BUDGET_TOKENS).toBe(
      USER_CONFIG_DEFAULTS.localModels.reasoningBudgetTokens,
    );
  });

  it("prices a budget at four characters per token, and keeps 0 unbounded", () => {
    expect(REASONING_CHARS_PER_TOKEN).toBe(4);
    expect(reasoningBudgetChars(1500)).toBe(6000);
    expect(reasoningBudgetChars(64)).toBe(256);
    expect(reasoningBudgetChars(0)).toBe(0);
    expect(reasoningBudgetChars(-5)).toBe(0);
    expect(reasoningBudgetChars(Number.NaN)).toBe(0);
  });

  it("prices a completion's reasoning at the same ratio, so a cut reads as the budget", () => {
    expect(estimateReasoningTokens("")).toBe(0);
    expect(estimateReasoningTokens("abc")).toBe(1);
    expect(estimateReasoningTokens("x".repeat(reasoningBudgetChars(1500)))).toBe(
      1500,
    );
  });
});
