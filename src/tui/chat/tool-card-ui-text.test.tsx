import { describe, expect, it } from "vitest";
import { renderAtSize } from "../test-sized-render.js";
import type { ToolCardEntry } from "../tui-state.js";
import { UI_RENDER_NEXT } from "../../tools/ui/index.js";
import { ToolCard } from "./tool-card.js";
import { uiCardLines } from "./tool-card-ui-text.js";

// ATO-2457: the terminal's form of a ui.render card.

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const SUMMARY = ["Choice: Which plan?", "  1. Fast: ships today", "  2. Safe", UI_RENDER_NEXT].join("\n");

const card = (over: Partial<ToolCardEntry> = {}): ToolCardEntry => ({
  id: "card-ui",
  stepIndex: 0,
  tool: "ui.render",
  args: { kind: "decision", title: "Which plan?" },
  status: "ok",
  summary: SUMMARY,
  truncated: false,
  startedAt: 1_000,
  finishedAt: 1_020,
  ...over,
});

function frameOf(c: ToolCardEntry): string {
  const app = renderAtSize(<ToolCard card={c} expanded={false} />, { columns: 120, rows: 20 });
  const frame = strip(app.lastFrame() ?? "");
  app.unmount();
  return frame;
}

describe("ui.render in the terminal", () => {
  it("prints every option of a closed card, not a one-line preview, and not the model's line", () => {
    const frame = frameOf(card());
    expect(frame).toContain("1. Fast: ships today");
    expect(frame).toContain("2. Safe");
    expect(frame).not.toContain("End this turn");
    // One option per row: the one-line preview would put them on one.
    const row = frame.split("\n").find((line) => line.includes("2. Safe")) ?? "";
    expect(row).not.toContain("Fast");
    expect(frame).not.toContain("Shown to the user");
  });

  it("leaves a failed call to the usual one-line preview", () => {
    const frame = frameOf(card({ status: "error", summary: "ui.render: `options` needs at least 2 items" }));
    expect(frame).toContain("ui.render: `options` needs at least 2 items");
  });

  it("drops only the model's line", () => {
    expect(uiCardLines(SUMMARY)).toEqual(["Choice: Which plan?", "  1. Fast: ships today", "  2. Safe"]);
  });
});
