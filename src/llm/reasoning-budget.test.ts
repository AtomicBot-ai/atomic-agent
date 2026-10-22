import { describe, expect, it, vi } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import {
  DEFAULT_REASONING_BUDGET_TOKENS,
  MAX_REASONING_BUDGET_TOKENS,
  REASONING_CHARS_PER_TOKEN,
  effectiveReasoningBudgetTokens,
  estimateReasoningTokens,
  logReasoningBudgetCap,
  REASONING_BUDGET_DISABLE_HINT,
  reasoningBudgetChars,
} from "./reasoning-budget.js";
import { GEMMA4_THINK_PROFILE, PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "./model-profile.js";

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

describe("reasoning budget cap (llama.cpp GBNF limit, #600)", () => {
  it("caps the enforceable budget at 499 tokens (1,999 grammar chars)", () => {
    expect(MAX_REASONING_BUDGET_TOKENS).toBe(499);
    expect(effectiveReasoningBudgetTokens(1500)).toBe(499);
    expect(effectiveReasoningBudgetTokens(500)).toBe(499);
    expect(effectiveReasoningBudgetTokens(499)).toBe(499);
    expect(effectiveReasoningBudgetTokens(64)).toBe(64);
    expect(effectiveReasoningBudgetTokens(0)).toBe(0);
  });

  const thinking = { profile: QWEN_THINK_PROFILE, thinking: "auto" };

  it("logs the cap once per call for a thinking model, at info, with the way to disable it", () => {
    const logger = { info: vi.fn() };
    logReasoningBudgetCap(logger, 1500, thinking);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "reasoning budget capped by llama.cpp grammar limit (set localModels.reasoningBudgetTokens 0 to disable)",
      { profile: "qwen-think", configuredTokens: 1500, effectiveTokens: 499, grammarChars: 1999 },
    );
    logReasoningBudgetCap(logger, 1500, { profile: GEMMA4_THINK_PROFILE, thinking: "on" });
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(REASONING_BUDGET_DISABLE_HINT).toBe("set localModels.reasoningBudgetTokens 0 to disable");
  });

  it("stays silent for an unbounded budget or one within the cap", () => {
    const logger = { info: vi.fn() };
    logReasoningBudgetCap(logger, 0, thinking);
    logReasoningBudgetCap(logger, 499, thinking);
    logReasoningBudgetCap(logger, 64, thinking);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stays silent for a model without thinking, or with thinking off", () => {
    const logger = { info: vi.fn() };
    logReasoningBudgetCap(logger, 1500, { profile: PLAIN_INSTRUCT_PROFILE, thinking: "auto" });
    logReasoningBudgetCap(logger, 1500, { profile: QWEN_THINK_PROFILE, thinking: "off" });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
