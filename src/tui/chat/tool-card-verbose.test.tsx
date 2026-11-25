import { describe, expect, it } from "vitest";
import { renderAtSize } from "../test-sized-render.js";
import type { StreamingToolCall, ToolCardEntry } from "../tui-state.js";
import { ToolCard } from "./tool-card.js";

// ATO-34: `/verbose` adds a plain step note under a finished card.

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const CARD: ToolCardEntry = {
  id: "card-read",
  stepIndex: 0,
  tool: "os.fs.read",
  args: { path: "a.ts" },
  status: "ok",
  summary: "file body",
  truncated: false,
  startedAt: 1_000,
  finishedAt: 1_020,
};

const PENDING: StreamingToolCall = {
  id: "call-1",
  stepIndex: 0,
  tool: "os.fs.read",
  args: { path: "a.ts" },
  startedAt: 1_000,
};

function frameOf(verbose: boolean, card: ToolCardEntry | StreamingToolCall = CARD): string {
  const app = renderAtSize(<ToolCard card={card} expanded={false} verbose={verbose} />, {
    columns: 120,
    rows: 20,
  });
  const frame = strip(app.lastFrame() ?? "");
  app.unmount();
  return frame;
}

describe("ToolCard verbose note", () => {
  it("shows the step note only when verbose is on", () => {
    expect(frameOf(true)).toContain('step 1 · called os.fs.read path="a.ts" · ok, 9 chars back');
    expect(frameOf(false)).not.toContain("step 1 · called");
  });

  it("adds nothing to a call still in flight", () => {
    expect(frameOf(true, PENDING)).not.toContain("step 1 · called");
  });
});
