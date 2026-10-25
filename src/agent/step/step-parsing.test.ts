import { describe, expect, it } from "vitest";
import { GEMMA4_THINK_PROFILE, PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { DEFAULT_REASONING_BUDGET_TOKENS } from "../../llm/reasoning-budget.js";
import { REPAIR_MAX_TOKENS, repairReplyCap } from "./step-parsing.js";

describe("repair completion cap", () => {
  it("keeps the 1024 anti-loop guard for a model without thinking", () => {
    expect(repairReplyCap("grammar", 8192)).toBe(REPAIR_MAX_TOKENS);
    expect(repairReplyCap("grammar", 8192, { profile: PLAIN_INSTRUCT_PROFILE, budgetTokens: 1500 })).toBe(REPAIR_MAX_TOKENS);
  });

  it("adds the enforced reasoning budget for a thinking profile on a grammar link", () => {
    for (const profile of [QWEN_THINK_PROFILE, GEMMA4_THINK_PROFILE]) {
      expect(repairReplyCap("grammar", 8192, { profile, budgetTokens: 1500 })).toBe(REPAIR_MAX_TOKENS + 1500);
      expect(repairReplyCap("grammar", 8192, { profile, budgetTokens: 64 })).toBe(REPAIR_MAX_TOKENS + 64);
      // Absent budget: whatever the default is, the same cap as passing it, as the grammar falls back to it too.
      expect(repairReplyCap("grammar", 8192, { profile })).toBe(
        repairReplyCap("grammar", 8192, { profile, budgetTokens: DEFAULT_REASONING_BUDGET_TOKENS }),
      );
    }
  });

  it("uses the step's cap for an unbounded budget, and the guard when thinking is off", () => {
    expect(repairReplyCap("grammar", 8192, { profile: QWEN_THINK_PROFILE, budgetTokens: 0 })).toBe(8192);
    expect(repairReplyCap("grammar", 512, { profile: QWEN_THINK_PROFILE, budgetTokens: 0 })).toBe(REPAIR_MAX_TOKENS);
    expect(repairReplyCap("grammar", 8192, { profile: QWEN_THINK_PROFILE, budgetTokens: 1500, thinkingOff: true })).toBe(REPAIR_MAX_TOKENS);
  });

  it("leaves native_tools on the step's cap", () => {
    expect(repairReplyCap("native_tools", 20_000)).toBe(20_000);
    expect(repairReplyCap("native_tools", 20_000, { profile: QWEN_THINK_PROFILE, budgetTokens: 1500 })).toBe(20_000);
  });
});
