import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAP_FLOOR,
  CONVERSATION_CAP_SAFETY_MARGIN,
  computeEffectiveConversationCap,
  defaultBudget,
  estimateTokens,
  truncateToTokens,
} from "./token-budget.js";

describe("defaultBudget", () => {
  it("splits the total across stable prefix and session", () => {
    const limits = defaultBudget(3000);
    expect(limits.total).toBe(3000);
    expect(limits.stablePrefix).toBe(1050);
    expect(limits.session).toBe(450);
  });

  it("prefers explicit caps for world and conversation", () => {
    const limits = defaultBudget(3000, {
      conversation: 32_000,
      worldSnapshot: 8_000,
    });
    expect(limits.conversation).toBe(32_000);
    expect(limits.worldSnapshot).toBe(8_000);
  });

  it("falls back to shares when explicit caps are omitted", () => {
    const limits = defaultBudget(3000);
    expect(limits.conversation).toBe(1050);
    expect(limits.worldSnapshot).toBe(450);
  });
});

describe("computeEffectiveConversationCap", () => {
  const base = {
    configuredCap: 32_000,
    stablePrefixTokens: 2000,
    sessionTokens: 400,
    worldSnapshotTokens: 2000,
    completionMaxTokens: 4096,
  };

  it("returns the configured cap when the model context window is unknown", () => {
    const cap = computeEffectiveConversationCap({
      ...base,
      contextWindow: undefined,
    });
    expect(cap).toBe(32_000);
  });

  it("keeps the configured cap when the model has plenty of room", () => {
    const cap = computeEffectiveConversationCap({
      ...base,
      contextWindow: 131_072,
    });
    expect(cap).toBe(32_000);
  });

  it("clamps down to available room when the context window is tight", () => {
    const cap = computeEffectiveConversationCap({
      ...base,
      contextWindow: 32_768,
    });
    const expected =
      32_768 -
      base.stablePrefixTokens -
      base.sessionTokens -
      base.worldSnapshotTokens -
      base.completionMaxTokens -
      CONVERSATION_CAP_SAFETY_MARGIN;
    expect(cap).toBe(expected);
    expect(cap).toBeLessThan(32_000);
  });

  it("never drops below the floor even on tiny context windows", () => {
    const cap = computeEffectiveConversationCap({
      ...base,
      contextWindow: 2048,
    });
    expect(cap).toBe(CONVERSATION_CAP_FLOOR);
  });

  it("honours a user-tightened configured cap", () => {
    const cap = computeEffectiveConversationCap({
      ...base,
      configuredCap: 4_000,
      contextWindow: 131_072,
    });
    expect(cap).toBe(4_000);
  });
});

describe("truncateToTokens", () => {
  it("returns the text unchanged when it already fits", () => {
    const text = "hello world";
    expect(truncateToTokens(text, 1000)).toBe(text);
  });

  it("trims long text and appends the marker", () => {
    const text = "x".repeat(2000);
    const out = truncateToTokens(text, 20);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(20);
  });

  it("returns an empty string when the budget is non-positive", () => {
    expect(truncateToTokens("abc", 0)).toBe("");
  });
});
