import { describe, expect, it } from "vitest";

import { replyReserveShown } from "./context-panel.js";
import { selectContextUsage } from "./select-context-usage.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type ContextUsageState } from "../tui-state.js";

/**
 * ATO-1678: on a window the instructions and tool schemas crowd, the
 * prompt budget holds back a shared reply reserve (5853 on a 32k window
 * with 20.5k of prefix and schemas), not `effectiveReplyReserve`'s
 * 16 384. The context panel shows the budget's figure.
 */

function usage(overrides: Partial<ContextUsageState> = {}): ContextUsageState {
  return {
    tokens: 20_000,
    contextWindow: 32_768,
    droppedTurns: 0,
    conversationTokens: 5000,
    conversationCap: 5853,
    conversationCapConfigured: 32_000,
    conversationCapAuto: true,
    conversationPairs: 1,
    droppedPairs: 0,
    conversationPairsCap: 0,
    conversationBoundBy: null,
    pairCosts: [],
    sections: [],
    ...overrides,
  };
}

describe("the reply reserve the context panel shows", () => {
  it("is the budget's shared reserve when the prompt reports one", () => {
    // Without it: the full 16 384, clamped to the 12 768 the prompt left.
    expect(replyReserveShown(16_384, 32_768, 20_000)).toBe(12_768);
    expect(replyReserveShown(16_384, 32_768, 20_000, 5853)).toBe(5853);
  });

  it("is still clamped to what the prompt left, and 0 with no cap", () => {
    expect(replyReserveShown(16_384, 32_768, 30_000, 5853)).toBe(2768);
    expect(replyReserveShown(0, 32_768, 20_000, 5853)).toBe(0);
  });

  it("reaches the panel's view from the last prompt's snapshot", () => {
    const state = {
      ...createInitialTuiState(fakeSession()),
      contextUsage: usage({ replyReserve: 5853 }),
    };
    expect(selectContextUsage(state)?.replyReserve).toBe(5853);
    const old = { ...state, contextUsage: usage() };
    expect(selectContextUsage(old)?.replyReserve).toBeUndefined();
  });
});
