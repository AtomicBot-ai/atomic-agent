import { describe, expect, it } from "vitest";

import { crowdedReplyReserve, CROWDED_WINDOW_REPLY_SHARE } from "./crowded-window.js";
import {
  computeEffectiveConversationCap,
  CONVERSATION_CAP_FLOOR,
  CONVERSATION_CAP_SAFETY_MARGIN,
  effectiveConversationBudget,
  effectiveReplyReserve,
  MIN_SMALL_WINDOW_REPLY_RESERVE,
} from "./token-budget.js";

/**
 * ATO-1678 (Sentry CLI-Q4, v0.10.0): a 32k local `native_tools` link
 * with a 4323-token prefix and 16 227 tokens of tool schemas. The full
 * 16 384 reply reserve no longer fit beside them, the transcript cap
 * clamped to the 512 floor, and the request still went out at the end
 * of the window with 265 tokens left for the reply.
 */
const SENTRY_EVENT = {
  configuredCap: 32_000,
  autoFill: true,
  contextWindow: 32_768,
  stablePrefixTokens: 4323,
  sessionTokens: 0,
  worldSnapshotTokens: 0,
  toolSchemaTokens: 16_227,
  completionMaxTokens: 16_384,
};

const LEFTOVER = 32_768 - 4323 - 16_227 - CONVERSATION_CAP_SAFETY_MARGIN; // 11 706

describe("crowdedReplyReserve", () => {
  const shared = (leftover: number, fullReserve = 16_384) =>
    crowdedReplyReserve({
      fullReserve,
      leftover,
      transcriptFloor: CONVERSATION_CAP_FLOOR,
      minReserve: MIN_SMALL_WINDOW_REPLY_RESERVE,
    });

  it("keeps the full reserve while the transcript still gets its floor", () => {
    expect(shared(16_384 + CONVERSATION_CAP_FLOOR)).toBe(16_384);
    expect(shared(40_000)).toBe(16_384);
  });

  it("shares a crowded leftover evenly with the transcript", () => {
    expect(shared(LEFTOVER)).toBe(Math.floor(LEFTOVER * CROWDED_WINDOW_REPLY_SHARE));
    expect(shared(LEFTOVER)).toBe(5853);
  });

  it("never goes under the minimum, nor over the full reserve", () => {
    expect(shared(800)).toBe(MIN_SMALL_WINDOW_REPLY_RESERVE);
    expect(shared(-3000)).toBe(MIN_SMALL_WINDOW_REPLY_RESERVE);
    expect(shared(2000, 600)).toBe(600);
  });

  it("leaves a reserve of nothing (no client-side cap) as it is", () => {
    expect(shared(LEFTOVER, 0)).toBe(0);
  });
});

describe("conversation budget on a window the fixed part crowds (ATO-1678)", () => {
  it("gives the transcript and the reply half of what the fixed part leaves", () => {
    const budget = effectiveConversationBudget(SENTRY_EVENT);
    // Before: the full 16 384 reserve, the cap clamped to the 512 floor.
    expect(effectiveReplyReserve(16_384, 32_768)).toBe(16_384);
    expect(budget.replyReserve).toBe(5853);
    expect(budget.cap).toBe(LEFTOVER - 5853);
    expect(budget.cap).toBeGreaterThan(CONVERSATION_CAP_FLOOR);
    expect(computeEffectiveConversationCap(SENTRY_EVENT)).toBe(budget.cap);
  });

  it("fits the window: fixed part, transcript cap, reply reserve and margin", () => {
    const budget = effectiveConversationBudget(SENTRY_EVENT);
    expect(
      4323 + 16_227 + budget.cap + budget.replyReserve + CONVERSATION_CAP_SAFETY_MARGIN,
    ).toBeLessThanOrEqual(32_768);
  });

  it("holds an operator's tighter cap and still reserves the shared figure", () => {
    const budget = effectiveConversationBudget({
      ...SENTRY_EVENT,
      autoFill: false,
      configuredCap: 2000,
    });
    expect(budget.cap).toBe(2000);
    expect(budget.replyReserve).toBe(5853);
  });

  it("keeps the old figures on a window that holds the full reserve", () => {
    const roomy = { ...SENTRY_EVENT, contextWindow: 65_536 };
    const budget = effectiveConversationBudget(roomy);
    expect(budget.replyReserve).toBe(16_384);
    expect(budget.cap).toBe(65_536 - 4323 - 16_227 - 16_384 - CONVERSATION_CAP_SAFETY_MARGIN);
  });

  it("keeps the floor when even the minimum reserve does not fit", () => {
    const budget = effectiveConversationBudget({ ...SENTRY_EVENT, contextWindow: 20_000 });
    expect(budget.cap).toBe(CONVERSATION_CAP_FLOOR);
    expect(budget.replyReserve).toBe(MIN_SMALL_WINDOW_REPLY_RESERVE);
  });
});
