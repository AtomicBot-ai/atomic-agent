import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { createCompactionDefaults } from "../../config/agent/compaction-config.js";
import { EMPTY_CONTEXT_USAGE } from "../../session/context-usage.js";
import { estimateTokens } from "../../prompt/token-budget.js";
import {
  UNKNOWN_WINDOW_HISTORY_LIMIT,
  fitsLocalWindow,
  localFirstSessionSize,
} from "./local-first-fit.js";

function config(overrides: { completionMaxTokens?: number; auto?: boolean; conversationMaxTokens?: number } = {}) {
  return {
    agent: {
      compaction: { ...createCompactionDefaults(), ...(overrides.auto !== undefined ? { auto: overrides.auto } : {}) },
      conversationMaxTokens: overrides.conversationMaxTokens ?? 0,
    },
    localModels: {
      completionMaxTokens: overrides.completionMaxTokens ?? 4096,
      thinking: "off",
      reasoningBudgetTokens: 0,
    },
  } as unknown as Pick<AtomicAgentConfig, "agent" | "localModels">;
}

describe("fitsLocalWindow (ATO-2537)", () => {
  it("compares history to the local history allowance, the way compaction triggers", () => {
    // 32k window, 4k reply reserve, 12k fixed: allowance about 16.2k,
    // compaction at 0.9 of it (about 14.5k of history).
    const window = 32_768;
    // A 25k prompt: 13k of history stays under the trigger.
    expect(fitsLocalWindow({ historyTokens: 13_000, fixedTokens: 12_000 }, window, config())).toBe(true);
    // A 28k prompt is under 0.9 x window, but its 16k of history is past
    // the trigger: the old whole-prompt check sent this turn local.
    expect(fitsLocalWindow({ historyTokens: 16_000, fixedTokens: 12_000 }, window, config())).toBe(false);
  });

  it("subtracts the reply reserve the local prompt build keeps", () => {
    // The default 16k completion ceiling takes half of a 32k window:
    // even a 25k prompt would be compacted.
    expect(
      fitsLocalWindow({ historyTokens: 13_000, fixedTokens: 12_000 }, 32_768, config({ completionMaxTokens: 16_384 })),
    ).toBe(false);
  });

  it("a long session fits a large local window", () => {
    expect(fitsLocalWindow({ historyTokens: 60_000, fixedTokens: 12_000 }, 131_072, config())).toBe(true);
  });

  it("an unknown window keeps only a short history local", () => {
    expect(fitsLocalWindow({ historyTokens: UNKNOWN_WINDOW_HISTORY_LIMIT, fixedTokens: 12_000 }, null, config())).toBe(true);
    expect(fitsLocalWindow({ historyTokens: UNKNOWN_WINDOW_HISTORY_LIMIT + 1, fixedTokens: 12_000 }, null, config())).toBe(false);
    expect(fitsLocalWindow({ historyTokens: 100_000, fixedTokens: 12_000 }, 0, config())).toBe(false);
  });

  it("no size, or automatic compaction off: it fits", () => {
    expect(fitsLocalWindow(null, 16_384, config())).toBe(true);
    expect(fitsLocalWindow({ historyTokens: 100_000, fixedTokens: 12_000 }, 16_384, config({ auto: false }))).toBe(true);
  });
});

describe("localFirstSessionSize (ATO-2537)", () => {
  it("splits the last prompt into history (transcript, summary, new message) and the fixed rest", () => {
    const size = localFirstSessionSize(
      {
        ...EMPTY_CONTEXT_USAGE,
        // The provider's own count, lower than the estimates: not used for the split.
        tokens: 20_000,
        conversationTokens: 15_000,
        sections: [
          { label: "prompt scaffold", tokens: 9_000 },
          { label: "conversation", tokens: 15_000 },
          { label: "context summary", tokens: 1_000 },
          { label: "loaded tools", tokens: 2_000 },
        ],
      },
      "hello there",
    );
    expect(size).toEqual({ historyTokens: 16_000 + estimateTokens("hello there"), fixedTokens: 11_000 });
  });

  it("is null when no prompt was built yet", () => {
    expect(localFirstSessionSize(undefined, "hi")).toBeNull();
    expect(localFirstSessionSize(null, "hi")).toBeNull();
    expect(localFirstSessionSize(EMPTY_CONTEXT_USAGE, "hi")).toBeNull();
  });
});
