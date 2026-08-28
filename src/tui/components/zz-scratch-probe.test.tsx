import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ContextUsageView } from "../select-context-usage.js";
import { ContextPanel } from "./context-panel.js";

const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

const SECTIONS = [
  { label: "prompt scaffold", tokens: 5240 },
  { label: "conversation", tokens: 31_880 },
  { label: "recalled memory", tokens: 2150 },
  { label: "session facts", tokens: 610 },
];

function usage(overrides: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    tokens: 39_880,
    contextWindow: 131_072,
    percent: 30,
    conversationTokens: 31_880,
    conversationCap: 32_000,
    conversationPercent: 100,
    capSource: "config",
    droppedTurns: 0,
    pairs: 8,
    pairsCap: 20,
    droppedPairs: 0,
    pairCosts: [4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000],
    overheadTokens: 8000,
    sections: SECTIONS,
    ...overrides,
  };
}

function frame(columns: number, rows: number, pairsDraft: number | null = null) {
  const { lastFrame, unmount } = render(
    <Box width={columns} height={rows} flexDirection="column">
      <ContextPanel
        usage={usage()}
        availableRows={rows}
        availableColumns={columns}
        reservedForReply={4096}
        pairsDraft={pairsDraft}
        onStepPairs={() => {}}
      />
    </Box>,
  );
  const out = (lastFrame() ?? "").replace(SGR, "");
  unmount();
  return out;
}

describe("probe", () => {
  it("dumps frames", () => {
    for (const [c, r, d] of [
      [100, 24, null],
      [100, 8, null],
      [100, 7, null],
      [100, 6, null],
      [36, 24, null],
      [35, 24, null],
      [34, 24, null],
      [30, 24, null],
      [100, 24, 1],
      [100, 24, 100],
      [34, 24, 1],
    ] as Array<[number, number, number | null]>) {
      const f = frame(c, r, d);
      const ls = f.split("\n");
      console.log(`\n### cols=${c} rows=${r} draft=${d} renderedLines=${ls.length}`);
      ls.forEach((l, i) => console.log(`${String(i).padStart(2)}|${l}|len=${l.length}`));
    }
    expect(true).toBe(true);
  });
});
