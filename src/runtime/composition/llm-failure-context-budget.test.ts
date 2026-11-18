import { describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";
import { ModelError } from "../../llm/index.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";
import { describeLlmFailure } from "./llm-failure-context.js";
import { promptBudgetOf } from "./prompt-budget.js";

/**
 * ATO-1678: a context-full report says which part filled the window
 * (prefix, native tool schemas, history, reply reserve) and what the
 * server counted, as numbers only.
 */

const noConfig = {
  readConfig: (): AtomicAgentConfig => {
    throw new Error("no config in this test");
  },
  readDaemonPidState: () => "unknown" as const,
};

function cutAtWindow(): ModelError {
  return new ModelError("truncated", "model response truncated", {
    truncation: { cause: "context_window", promptTokens: 30_100, completionTokens: 2_660, requestedMaxTokens: 8192 },
  });
}

describe("describeLlmFailure prompt budget (ATO-1678)", () => {
  it("carries the truncation counts off the error chain, without its message", () => {
    const wrapped = new Error("step failed", { cause: cutAtWindow() });
    const context = describeLlmFailure({ error: wrapped }, noConfig);
    expect(context.truncationCounts).toEqual({ promptTokens: 30_100, completionTokens: 2_660, requestedMaxTokens: 8192 });
    expect(JSON.stringify(context)).not.toContain("model response truncated");
  });

  it("keeps the budget even when the provider lookup fails", () => {
    const budget = {
      totalTokens: 27_000, stablePrefixTokens: 9_000, toolSchemaTokens: 6_000,
      conversationTokens: 11_000, contextWindow: 32_768, replyReserve: 4096,
    };
    expect(describeLlmFailure({ error: cutAtWindow() }, noConfig, budget).promptBudget).toEqual(budget);
  });

  it("reports nothing extra for an error that is not a truncation", () => {
    const context = describeLlmFailure({ error: new Error("fetch failed") }, noConfig);
    expect(context.truncationCounts).toBeUndefined();
    expect(context.promptBudget).toBeUndefined();
  });
});

describe("promptBudgetOf", () => {
  const base = {
    tokens: {
      stablePrefix: 9_000, loadedSkills: 0, sessionFacts: 0, loadedTools: 0, profile: 0,
      worldSnapshot: 0, conversation: 11_000, recalled: 0, memoryIndex: 0, taskPolicy: 0,
      toolSchema: 6_000, total: 27_000,
    },
    contextWindow: 32_768,
  };

  it("reads a local prompt's parts and its reply reserve", () => {
    const prompt = { ...base, replyReserve: 4096 } as unknown as BuiltPrompt;
    expect(promptBudgetOf(prompt)).toEqual({
      totalTokens: 27_000, stablePrefixTokens: 9_000, toolSchemaTokens: 6_000,
      conversationTokens: 11_000, contextWindow: 32_768, replyReserve: 4096,
    });
  });

  it("reads a cloud prompt's reserve off its context budget", () => {
    const prompt = { ...base, contextBudget: { window: 32_768, replyReserve: 16_000 } } as unknown as BuiltPrompt;
    expect(promptBudgetOf(prompt).replyReserve).toBe(16_000);
  });
});
