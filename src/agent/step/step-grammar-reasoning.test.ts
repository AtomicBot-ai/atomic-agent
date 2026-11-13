import { describe, expect, it } from "vitest";

import { resolveStepGrammar } from "./step-inference.js";
import { buildReasoningPreludeRules } from "../../llm/grammar/reasoning-prelude.js";
import { reasoningBudgetChars } from "../../llm/reasoning-budget.js";
import { LOCAL_REASONING_BUDGET_TOKENS, withReasoningBudget } from "../../llm/reasoning-levels.js";
import type { StepDependencies } from "./step-contract.js";

// ATO-490: the chat's reasoning level sets a local thinking model's budget.
const grammar = `root ::= think-prelude tool-call-array\ntool-call-array ::= "[" "]"\n${buildReasoningPreludeRules(
  "think", "</think>", undefined, reasoningBudgetChars(1_500),
)}\n`;
const deps = { registry: undefined, grammar } as unknown as Pick<
  StepDependencies, "registry" | "isFusionOrchestrator" | "grammar"
>;

describe("resolveStepGrammar with a reasoning level (ATO-490)", () => {
  it("sends the base grammar byte-identical when no level is picked", () => {
    expect(resolveStepGrammar({}, deps, [], false)).toBe(grammar);
  });

  it("bounds the think block by the level's budget", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(resolveStepGrammar({ reasoningOverride: level }, deps, [], false)).toBe(
        withReasoningBudget(grammar, LOCAL_REASONING_BUDGET_TOKENS[level]),
      );
    }
    expect(resolveStepGrammar({ reasoningOverride: "low" }, deps, [], false)).not.toBe(grammar);
  });

  it("leaves thinking off and the forced final step as they were", () => {
    expect(resolveStepGrammar({ reasoningOverride: "low" }, deps, [], true)).toBe(resolveStepGrammar({}, deps, [], true));
    expect(resolveStepGrammar({ reasoningOverride: "low", terminalOnly: true }, deps, [], false)).toBe(
      resolveStepGrammar({ terminalOnly: true }, deps, [], false),
    );
  });
});
