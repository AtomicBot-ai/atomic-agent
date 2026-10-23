import { describe, expect, it } from "vitest";
import { COMPACTION_REQUEST_MARGIN_TOKENS, compactionReplyBudget, REASONING_RESERVE_MAX_SHARE } from "./compaction-reply-budget.js";

describe("compactionReplyBudget", () => {
  it("gives the reply room to think beyond the summary target on a large window", () => {
    const budget = compactionReplyBudget(131072, 2048, 4096);
    expect(budget).toEqual({ reasoningReserve: 4096, maxTokens: 2048 + 4096, inputBudget: 131072 - 2048 - 4096 - COMPACTION_REQUEST_MARGIN_TOKENS });
    expect(budget.maxTokens).toBeGreaterThan(2048);
  });

  it("shrinks the reserve on a small window so input keeps most of the room", () => {
    const room = 8192 - 1024 - COMPACTION_REQUEST_MARGIN_TOKENS;
    const budget = compactionReplyBudget(8192, 1024, 4096);
    expect(budget.reasoningReserve).toBe(Math.floor(room * REASONING_RESERVE_MAX_SHARE));
    expect(budget.reasoningReserve).toBeLessThan(4096);
    expect(budget.inputBudget).toBe(room - budget.reasoningReserve);
    expect(budget.inputBudget + budget.maxTokens + COMPACTION_REQUEST_MARGIN_TOKENS).toBe(8192);
  });

  it("grants no reserve when it is turned off or the window has no room left", () => {
    expect(compactionReplyBudget(131072, 2048, 0)).toMatchObject({ reasoningReserve: 0, maxTokens: 2048 });
    expect(compactionReplyBudget(2000, 1500, 4096)).toMatchObject({ reasoningReserve: 0, maxTokens: 1500, inputBudget: 2000 - 1500 - COMPACTION_REQUEST_MARGIN_TOKENS });
  });

  it("keeps the reply allowance under the provider entry's own output cap, never below the summary target", () => {
    expect(compactionReplyBudget(131072, 2048, 4096, 4096)).toEqual({ reasoningReserve: 2048, maxTokens: 4096, inputBudget: 131072 - 2048 - 2048 - COMPACTION_REQUEST_MARGIN_TOKENS });
    expect(compactionReplyBudget(131072, 2048, 4096, 16384)).toMatchObject({ reasoningReserve: 4096, maxTokens: 6144 });
    // A cap below the summary target sends the target, as before the reserve existed.
    expect(compactionReplyBudget(131072, 2048, 4096, 1000)).toMatchObject({ reasoningReserve: 0, maxTokens: 2048 });
  });
});
