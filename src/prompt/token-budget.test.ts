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

  /**
   * The report this behaviour came from: `llama-server -c 48000`, and
   * the composer reads `32k`. Nothing is broken — 32k is
   * `agent.conversationMaxTokens`, and it is a *ceiling*, so it does not
   * move when the window grows past it. These pin both halves: that the
   * old default really does decline the extra room, and that `0` claims
   * it.
   */
  describe("a window larger than the configured ceiling", () => {
    const window48k = { ...base, contextWindow: 48_000 };

    it("holds the transcript at the configured ceiling", () => {
      // 48000 - 2000 - 400 - 2000 - 4096 - 512 = 38 992 available, and
      // the operator's 32k ceiling is the smaller of the two.
      expect(computeEffectiveConversationCap(window48k)).toBe(32_000);
    });

    it("fills the window under auto", () => {
      expect(
        computeEffectiveConversationCap({ ...window48k, autoFill: true }),
      ).toBe(38_992);
    });

    it("is unchanged by auto when the window is the smaller of the two", () => {
      // A 32k window leaves 22 992 — under the 32k ceiling — so the
      // ceiling was never what bound, and switching it off buys nothing.
      // This is why the default can stay where it is: for everyone whose
      // window is at or below it, auto is a no-op.
      const window32k = { ...base, contextWindow: 32_768 };
      expect(computeEffectiveConversationCap(window32k)).toBe(23_760);
      expect(
        computeEffectiveConversationCap({ ...window32k, autoFill: true }),
      ).toBe(23_760);
    });

    it("falls back to the configured figure under auto with no window", () => {
      // Auto cannot mean "unbounded": with no window there is nothing to
      // subtract from, and an unbounded transcript against somebody
      // else's server is a promise this process cannot keep.
      expect(
        computeEffectiveConversationCap({
          ...base,
          contextWindow: undefined,
          autoFill: true,
        }),
      ).toBe(32_000);
    });

    it("keeps the floor under auto on a window too small to hold the prompt", () => {
      expect(
        computeEffectiveConversationCap({
          ...base,
          contextWindow: 4096,
          autoFill: true,
        }),
      ).toBe(512);
    });
  });

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
