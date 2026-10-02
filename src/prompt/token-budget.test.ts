import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAP_FLOOR,
  CONVERSATION_CAP_SAFETY_MARGIN,
  computeEffectiveConversationCap,
  defaultBudget,
  effectiveReplyReserve,
  estimateTokens,
  minUsableContextWindow,
  SESSION_SECTIONS_BUDGET_SHARE,
  SESSION_SECTIONS_CAP_AUTO,
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

  it("prefers an explicit session cap over the share", () => {
    expect(defaultBudget(3000, { session: 4000 }).session).toBe(4000);
    expect(defaultBudget(3000, { session: 100 }).session).toBe(100);
  });

  /**
   * `buildPrompt` screens the sentinel out before it gets here, but
   * `defaultBudget` is re-exported from `src/prompt/index.ts`, so a
   * caller that hands the config value straight through is a supported
   * use. `0` there must mean the share it is documented to mean — under
   * `??` it would reach `truncateToTokens(text, 0)` and silently empty
   * both sections.
   */
  it("reads a SESSION_SECTIONS_CAP_AUTO session cap as the share", () => {
    expect(
      defaultBudget(3000, { session: SESSION_SECTIONS_CAP_AUTO }).session,
    ).toBe(450);
    expect(defaultBudget(6000, { session: 0 }).session).toBe(900);
  });

  /**
   * `agent.sessionSectionsMaxTokens` is additive: an operator who never
   * writes it must get byte-identical prompts, at whatever
   * `agent.tokenBudget` they already run. A regression here changes the
   * session cap for every install at once, so the shares are pinned as
   * literals rather than recomputed from the constants they came from.
   *
   * `3001` is in the list because every other budget here is an exact
   * multiple of both shares, and a table of exact multiples cannot see
   * `Math.floor` turn into `Math.ceil` — the one rounding change that
   * moves every prompt on every install.
   */
  it("reproduces the pre-key shares across the budgets people run", () => {
    for (const [total, stablePrefix, session] of [
      [400, 140, 60],
      [500, 175, 75],
      [3000, 1050, 450],
      [3001, 1050, 450],
      [6000, 2100, 900],
      [32_000, 11_200, 4800],
    ] as const) {
      const limits = defaultBudget(total);
      expect(limits.stablePrefix).toBe(stablePrefix);
      expect(limits.session).toBe(session);
    }
  });

  it("keeps SESSION_SECTIONS_BUDGET_SHARE the share the fallback uses", () => {
    expect(SESSION_SECTIONS_CAP_AUTO).toBe(0);
    expect(defaultBudget(3000).session).toBe(
      Math.floor(3000 * SESSION_SECTIONS_BUDGET_SHARE),
    );
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

describe("effectiveReplyReserve", () => {
  it("keeps a configured cap that fits in half the window", () => {
    expect(effectiveReplyReserve(4096, 32_768)).toBe(4096);
    // The default on a 32k window is exactly half: untouched.
    expect(effectiveReplyReserve(16_384, 32_768)).toBe(16_384);
  });

  it("holds a cap bigger than the window to half of it", () => {
    // completionMaxTokens raised to 96k for long runs, on a 32k model.
    expect(effectiveReplyReserve(96_000, 32_768)).toBe(16_384);
  });

  it("keeps the configured figure when the window is unknown", () => {
    expect(effectiveReplyReserve(96_000, null)).toBe(96_000);
    expect(effectiveReplyReserve(96_000, undefined)).toBe(96_000);
  });

  it("reserves nothing for the no-cap sentinel", () => {
    expect(effectiveReplyReserve(0, 32_768)).toBe(0);
  });
});

describe("computeEffectiveConversationCap with a reply cap past the window", () => {
  /**
   * The QA report behind this: `completionMaxTokens: 96000` on a 32.8k
   * window. Subtracting the whole cap left a negative remainder and the
   * transcript sat on the 512-token floor every step.
   */
  it("budgets half the window for the reply instead of the floor", () => {
    const cap = computeEffectiveConversationCap({
      configuredCap: 32_000,
      stablePrefixTokens: 2000,
      sessionTokens: 400,
      worldSnapshotTokens: 2000,
      completionMaxTokens: 96_000,
      contextWindow: 32_768,
    });
    // 32768 - 2000 - 400 - 2000 - 16384 - 512
    expect(cap).toBe(11_472);
    expect(cap).toBeGreaterThan(CONVERSATION_CAP_FLOOR);
  });
});

describe("minUsableContextWindow", () => {
  it("counts the full cap when no window is being judged", () => {
    expect(minUsableContextWindow(16_384)).toBe(6000 + 16_384 + 512);
  });

  it("judges a window by the reserve the budget holds on it", () => {
    // 96k on a 32k window reserves 16 384, so 32k is usable: no warning.
    expect(minUsableContextWindow(96_000, 32_768)).toBe(6000 + 16_384 + 512);
    expect(32_768).toBeGreaterThanOrEqual(minUsableContextWindow(96_000, 32_768));
    // A window too small for the scaffolding plus half of itself still is.
    expect(12_000).toBeLessThan(minUsableContextWindow(96_000, 12_000));
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
