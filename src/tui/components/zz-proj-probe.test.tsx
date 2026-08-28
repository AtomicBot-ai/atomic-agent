import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ContextUsageView } from "../select-context-usage.js";
import { usageAtPairs } from "../select-context-usage.js";
import { ContextPanel } from "./context-panel.js";

const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

/** 20 tasks at 4k each = 80k of transcript, capped at 32k -> 8 visible. */
function capped(): ContextUsageView {
  return {
    tokens: 39_880,
    contextWindow: 131_072,
    percent: 30,
    conversationTokens: 31_880,
    conversationCap: 32_000,
    conversationPercent: 100,
    capSource: "tokens" as const,
    droppedTurns: 96,
    pairs: 8,
    pairsCap: 20,
    droppedPairs: 12,
    pairCosts: Array.from({ length: 20 }, () => 4000),
    overheadTokens: 8000,
    sections: [
      { label: "prompt scaffold", tokens: 5240 },
      { label: "conversation", tokens: 31_880 },
      { label: "recalled memory", tokens: 2150 },
      { label: "session facts", tokens: 610 },
    ],
  };
}

function lines(view: ContextUsageView, pairsDraft: number | null): string[] {
  const { lastFrame, unmount } = render(
    <Box width={100} height={24} flexDirection="column">
      <ContextPanel
        usage={view}
        availableRows={24}
        availableColumns={100}
        reservedForReply={4096}
        pairsDraft={pairsDraft}
      />
    </Box>,
  );
  const out = (lastFrame() ?? "").replace(SGR, "").split("\n").filter((l) => l.trim().length > 0);
  unmount();
  return out;
}

describe("probe", () => {
  it("shows what pressing minus does", () => {
    console.log("=== measured (draft null, cap 20) ===");
    console.log(lines(capped(), null).join("\n"));
    console.log("=== after one press of '-' (draft 19) ===");
    console.log(lines(capped(), 19).join("\n"));
    console.log("=== after pressing '-' to 4 ===");
    console.log(lines(capped(), 4).join("\n"));
    console.log("projected at 19:", JSON.stringify(usageAtPairs(capped(), 19), null, 1));
    expect(true).toBe(true);
  });
});
