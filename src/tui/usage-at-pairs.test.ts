import { describe, expect, it } from "vitest";

import { usageAtPairs, type ContextUsageView } from "./select-context-usage.js";

function view(overrides: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    tokens: 40_000,
    contextWindow: 128_000,
    percent: 31,
    conversationTokens: 32_000,
    conversationCap: 32_000,
    conversationPercent: 100,
    capSource: "pairs",
    droppedTurns: 0,
    pairs: 8,
    pairsCap: 20,
    droppedPairs: 0,
    // Ten tasks at a flat 4k.
    pairCosts: Array.from({ length: 10 }, () => 4000),
    sections: [
      { label: "prompt scaffold", tokens: 5000 },
      { label: "conversation", tokens: 32_000 },
      { label: "recalled memory", tokens: 3000 },
    ],
    ...overrides,
  };
}

/** Everything that is not the transcript: 5000 + 3000. */
const OVERHEAD = 8000;

/**
 * The panel's arithmetic has to be the packer's arithmetic. Two limits
 * bound the real transcript — the task count the operator picked and the
 * token cap underneath it — and a projection that honoured only the
 * first described a prompt that would never be built.
 */
describe("projecting the readout at a task count", () => {
  it("adds up the newest tasks", () => {
    const out = usageAtPairs(view(), 3);
    expect(out.conversationTokens).toBe(12_000);
    expect(out.tokens).toBe(OVERHEAD + 12_000);
    expect(out.pairs).toBe(3);
  });

  it("stops where the token cap would stop it", () => {
    // Asking for all ten tasks is 40k against a 32k cap. The packer
    // would carry eight; claiming ten would overstate the transcript by
    // a quarter and the operator would set a limit against a number the
    // agent never sees.
    const out = usageAtPairs(view(), 10);
    expect(out.conversationTokens).toBe(32_000);
    expect(out.pairs).toBe(8);
  });

  it("counts what it had to drop, not what the last build dropped", () => {
    // `droppedPairs` is what the footer reads. Spreading the measured
    // value through would have it contradict the projection above it.
    expect(usageAtPairs(view({ droppedPairs: 99 }), 4).droppedPairs).toBe(6);
    expect(usageAtPairs(view({ droppedPairs: 99 }), 10).droppedPairs).toBe(2);
  });

  it("keeps the newest task whatever it costs", () => {
    // The packer pins it — the model must not lose the request it is
    // answering — so a single task larger than the whole cap still
    // shows, and shows honestly as over the cap rather than as zero.
    const huge = view({ pairCosts: [4000, 99_000], conversationCap: 32_000 });
    const out = usageAtPairs(huge, 1);
    expect(out.pairs).toBe(1);
    expect(out.conversationTokens).toBe(99_000);
  });

  it("measures overhead the same way it measures the transcript", () => {
    // `tokens` becomes the provider's real count once a turn completes
    // while the sections stay estimates. Deriving overhead by
    // subtraction would mix the two and dump the estimator's bias into
    // every projection below the current task count.
    const drifted = view({ tokens: 30_000 });
    expect(usageAtPairs(drifted, 2).tokens).toBe(OVERHEAD + 8000);
  });

  it("asks for more tasks than exist without inventing any", () => {
    const out = usageAtPairs(view({ pairCosts: [4000, 4000] }), 50);
    expect(out.pairs).toBe(2);
    expect(out.conversationTokens).toBe(8000);
    expect(out.droppedPairs).toBe(0);
  });

  it("handles a session with no tasks yet", () => {
    const out = usageAtPairs(view({ pairCosts: [], sections: [] }), 20);
    expect(out.pairs).toBe(0);
    expect(out.tokens).toBe(0);
    expect(out.droppedPairs).toBe(0);
  });

  it("reports no percentage when nobody knows the window", () => {
    expect(usageAtPairs(view({ contextWindow: null }), 3).percent).toBeNull();
  });
});
