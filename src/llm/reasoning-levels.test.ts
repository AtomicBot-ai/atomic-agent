import { describe, expect, it } from "vitest";

import {
  LOCAL_REASONING_BUDGET_TOKENS,
  cloudModelReasons,
  cloudTakesReasoningOverride,
  reasoningControlFor,
  reasoningLevelsFor,
  reasoningOverrideFromRequest,
  withReasoningBudget,
} from "./reasoning-levels.js";
import { buildReasoningPreludeRules } from "./grammar/reasoning-prelude.js";
import { reasoningBudgetChars } from "./reasoning-budget.js";

const BASE = 'tool-call-array ::= "[" ws "]"\nws ::= [ \\t\\n]*';

/** A grammar shaped like `buildGrammar`'s for a thinking profile. */
function thinkingGrammar(budgetTokens: number, stem = "think", close = "</think>"): string {
  return `root ::= ${stem}-prelude tool-call-array\n${BASE}\n${buildReasoningPreludeRules(stem, close, undefined, reasoningBudgetChars(budgetTokens))}\n`;
}

describe("reasoningOverrideFromRequest", () => {
  it("reads low, medium and high in any case, and nothing else", () => {
    expect(reasoningOverrideFromRequest("low")).toBe("low");
    expect(reasoningOverrideFromRequest(" MEDIUM ")).toBe("medium");
    expect(reasoningOverrideFromRequest("high")).toBe("high");
    for (const v of ["auto", "minimal", "none", "xhigh", "", null, undefined, 2, { effort: "low" }]) {
      expect(reasoningOverrideFromRequest(v)).toBeUndefined();
    }
  });
});

describe("cloudModelReasons", () => {
  it("knows the reasoning families, with or without a router prefix", () => {
    for (const id of [
      "o3", "o4-mini", "gpt-5.4-mini", "openai/gpt-6-terra", "gpt-oss-120b",
      "claude-opus-5-5", "anthropic/claude-sonnet-4.5", "claude-3-7-sonnet-latest", "claude-haiku-4-5",
      "anthropic/claude-fable-5.2", "gemini-2.5-pro", "google/gemini-3-pro-preview",
      "deepseek/deepseek-r1", "deepseek-reasoner", "x-ai/grok-4", "grok-3-mini",
      "qwen/qwen3-235b-a22b", "qwq-32b", "moonshotai/kimi-k2-thinking", "z-ai/glm-4.6", "minimax/minimax-m2",
    ]) {
      expect(cloudModelReasons(id), id).toBe(true);
    }
  });

  it("leaves models that do not reason, and non-chat variants, out", () => {
    for (const id of [
      "gpt-4o", "gpt-4.1-mini", "gpt-5-chat-latest", "claude-3-5-sonnet-latest", "claude-haiku-3",
      "gemini-2.0-flash", "gemini-2.5-flash-image", "deepseek-chat", "llama-3.3-70b", "mistral-large", "", undefined,
    ]) {
      expect(cloudModelReasons(id), String(id)).toBe(false);
    }
  });
});

describe("cloudTakesReasoningOverride", () => {
  it("needs both a kind with an effort field and a model that reasons", () => {
    expect(cloudTakesReasoningOverride("openrouter", "openai/o3")).toBe(true);
    expect(cloudTakesReasoningOverride("openai-compatible", "gpt-5.4")).toBe(true);
    expect(cloudTakesReasoningOverride("gemini", "gemini-2.5-pro")).toBe(true);
    expect(cloudTakesReasoningOverride("openrouter", "openai/gpt-4o")).toBe(false);
    // A kind without a documented field gets nothing whatever the model.
    expect(cloudTakesReasoningOverride("subscription-cli", "claude-opus-5-5")).toBe(false);
    expect(cloudTakesReasoningOverride(undefined, "o3")).toBe(false);
  });
});

describe("reasoningControlFor / reasoningLevelsFor", () => {
  it("is a budget on a thinking local model, an effort on a reasoning cloud model, none otherwise", () => {
    expect(reasoningControlFor({ providerKind: "llama-server", modelId: "qwen3-8b", localThinks: true })).toBe("budget");
    expect(reasoningControlFor({ providerKind: "llama-server", modelId: "qwen3-8b", localThinks: false })).toBe("none");
    expect(reasoningControlFor({ providerKind: "openrouter", modelId: "anthropic/claude-opus-5.5" })).toBe("effort");
    expect(reasoningControlFor({ providerKind: "openrouter", modelId: "meta-llama/llama-3.3-70b" })).toBe("none");
    expect(reasoningLevelsFor("effort")).toEqual(["auto", "low", "medium", "high"]);
    expect(reasoningLevelsFor("budget")).toEqual(["auto", "low", "medium", "high"]);
    expect(reasoningLevelsFor("none")).toEqual(["auto"]);
  });
});

describe("withReasoningBudget", () => {
  it("returns a grammar without a reasoning prelude unchanged", () => {
    const plain = `root ::= tool-call-array\n${BASE}\n`;
    expect(withReasoningBudget(plain, 1_000)).toBe(plain);
  });

  it("rebounds a bounded grammar exactly as building it with the new budget would", () => {
    for (const [from, to] of [[1_500, 1_000], [1_000, 4_000], [4_000, 1_000], [499, 499]] as const) {
      expect(withReasoningBudget(thinkingGrammar(from), to)).toBe(thinkingGrammar(to));
    }
  });

  it("bounds an unbounded grammar: the same rules as a bounded build, the old fragment rule kept", () => {
    const out = withReasoningBudget(thinkingGrammar(0), 1_000);
    const without = out.split("\n").filter((l) => !l.startsWith("think-fragment ::= ")).join("\n");
    expect(without).toBe(thinkingGrammar(1_000));
    expect(out).toContain("think-body ::= think-char{0,1998} | think-char{1999} think-body-2");
    expect(out).toMatch(/^think-char ::= \[\^<\] \| "<" \[\^\/\]/m);
  });

  it("lifts the bound for High, keeping every rule a bounded body refers to", () => {
    const out = withReasoningBudget(thinkingGrammar(1_500), LOCAL_REASONING_BUDGET_TOKENS.high);
    expect(out).toMatch(/^think-body ::= think-char\*$/m);
    expect(out).not.toMatch(/^think-body-\d+ ::= /m);
    expect(out).toMatch(/^think-char ::= /m);
    // An unbounded grammar stays unbounded, the same string.
    expect(withReasoningBudget(thinkingGrammar(0), 0)).toBe(thinkingGrammar(0));
  });

  it("works for Gemma's channel stem", () => {
    const g = thinkingGrammar(0, "channel", "<channel|>");
    expect(withReasoningBudget(g, 1_000)).toMatch(/^channel-body ::= channel-char\{0,1998\} \| channel-char\{1999\} channel-body-2$/m);
  });

  it("maps the levels onto budgets: Low below Medium, High unbounded", () => {
    expect(LOCAL_REASONING_BUDGET_TOKENS.low).toBeLessThan(LOCAL_REASONING_BUDGET_TOKENS.medium);
    expect(LOCAL_REASONING_BUDGET_TOKENS.high).toBe(0);
  });
});
