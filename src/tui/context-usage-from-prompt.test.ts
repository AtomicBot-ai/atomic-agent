import { describe, expect, it } from "vitest";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import { contextUsageFromPrompt } from "./context-usage-from-prompt.js";

function builtPrompt(overrides: Partial<BuiltPrompt> = {}): BuiltPrompt {
  return {
    text: "",
    stablePrefix: "",
    tail: "",
    tokens: {
      stablePrefix: 5240,
      loadedSkills: 0,
      sessionFacts: 610,
      loadedTools: 0,
      profile: 0,
      worldSnapshot: 1020,
      conversation: 31_880,
      recalled: 2150,
      memoryIndex: 0,
      taskPolicy: 0,
      total: 40_900,
    },
    limits: {
      total: 40_000,
      stablePrefix: 14_000,
      session: 6000,
      worldSnapshot: 6000,
      conversation: 14_000,
    },
    truncated: false,
    truncation: {
      loadedSkills: false,
      sessionFacts: false,
      loadedTools: false,
      profile: false,
      worldSnapshot: false,
      conversation: false,
      recalled: false,
      memoryIndex: false,
    },
    contextWindow: 131_072,
    conversationCapEffective: 14_000,
    droppedTurns: 0,
    ...overrides,
  };
}

describe("contextUsageFromPrompt", () => {
  it("carries the total, the window and the dropped-turn count", () => {
    const usage = contextUsageFromPrompt(builtPrompt({ droppedTurns: 12 }));
    expect(usage.tokens).toBe(40_900);
    expect(usage.contextWindow).toBe(131_072);
    expect(usage.droppedTurns).toBe(12);
  });

  /**
   * A session with no skills loaded should not have to read the word
   * "skills" to find that out.
   */
  it("lists only the sections that cost something", () => {
    const usage = contextUsageFromPrompt(builtPrompt());
    expect(usage.sections.map((s) => s.label)).toEqual([
      "prompt scaffold",
      "conversation",
      "recalled memory",
      "world snapshot",
      "session facts",
    ]);
    expect(usage.sections[1]).toEqual({
      label: "conversation",
      tokens: 31_880,
    });
  });

  it("reports a cloud prompt's unknown window as unknown", () => {
    expect(contextUsageFromPrompt(builtPrompt({ contextWindow: null })).contextWindow).toBeNull();
  });
});
