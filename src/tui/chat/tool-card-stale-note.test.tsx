import { describe, expect, it } from "vitest";
import { renderAtSize } from "../test-sized-render.js";
import type { ToolCardEntry } from "../tui-state.js";
import { estimateToolCardHeight } from "./chat-message-height.js";
import { splitStaleReadNote, ToolCard } from "./tool-card.js";

const NOTE =
  "note: this file changed since you last read it; re-read it before editing it again.";
const LONG_PATH = `/Users/someone/projects/${"deeply-nested-folder/".repeat(8)}component.tsx`;

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function editCard(overrides: Partial<ToolCardEntry> = {}): ToolCardEntry {
  return {
    id: "card-edit",
    stepIndex: 0,
    tool: "os.fs.edit",
    args: { path: LONG_PATH, oldString: "a".repeat(80), newString: "b" },
    status: "error",
    summary: `os.fs.edit: oldString not found in ${LONG_PATH}; check whitespace and indentation\n${NOTE}`,
    truncated: false,
    startedAt: 1_000,
    finishedAt: 1_012,
    ...overrides,
  };
}

/** The frame with wrapped rows joined, so a wrapped note still matches. */
function renderFlat(card: ToolCardEntry, columns: number): string {
  const app = renderAtSize(<ToolCard card={card} expanded={false} />, {
    columns,
    rows: 40,
  });
  const frame = strip(app.lastFrame() ?? "");
  app.unmount();
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join(" ")
    .replace(/[│└─]\s*/g, "")
    .replace(/\s+/g, " ");
}

describe("ToolCard stale-read note (ATO-914)", () => {
  it("keeps the note visible on a failed edit with a long path in a narrow terminal", () => {
    const flat = renderFlat(editCard(), 50);
    expect(flat).toContain("changed since you last read it");
    expect(flat).toContain("re-read it before editing it again.");
  });

  it("keeps the note on a successful edit and still shows the result", () => {
    const flat = renderFlat(
      editCard({ status: "ok", summary: `${NOTE}\nedited ${LONG_PATH} (1 replacement)` }),
      60,
    );
    expect(flat).toContain("re-read it before editing it again.");
    expect(flat).toContain("edited");
  });

  it("charges the note's row in the height estimate", () => {
    expect(estimateToolCardHeight(editCard())).toBeGreaterThanOrEqual(3);
  });
});

describe("splitStaleReadNote", () => {
  it("lifts the note out wherever it sits and leaves other summaries alone", () => {
    expect(splitStaleReadNote(`boom\n${NOTE}`)).toEqual({ rest: "boom", notes: [NOTE] });
    expect(splitStaleReadNote(`${NOTE}\nedited a.ts`)).toEqual({
      rest: "edited a.ts",
      notes: [NOTE],
    });
    const many =
      "note: these files changed since you last read them: a.ts, b.ts; re-read them before editing them again.";
    expect(splitStaleReadNote(`patched 2 files\n${many}`).notes).toEqual([many]);
    expect(splitStaleReadNote("read 42 lines")).toEqual({
      rest: "read 42 lines",
      notes: [],
    });
  });
});
