import { describe, expect, it } from "vitest";
import type { ToolCardEntry } from "../tui-state.js";
import { estimateToolCardHeight } from "./chat-message-height.js";
import { resultSizeLabel, stepArgsLabel, stepNoteLine } from "./step-note.js";

// ATO-34: the one-line note `/verbose` puts under each finished tool card.

function card(extra: Partial<ToolCardEntry> = {}): ToolCardEntry {
  return {
    id: "c",
    stepIndex: 2,
    tool: "os.fs.read",
    args: { path: "src/a.ts" },
    status: "ok",
    summary: "x".repeat(1234),
    truncated: false,
    startedAt: 0,
    finishedAt: 10,
    ...extra,
  };
}

describe("stepNoteLine", () => {
  it("names the step (1-based), the call with its args and what came back", () => {
    expect(stepNoteLine(card())).toBe(
      'step 3 · called os.fs.read path="src/a.ts" · ok, 1.2k chars back',
    );
  });

  it("says a failed call failed and flags a truncated result", () => {
    expect(
      stepNoteLine(card({ status: "error", summary: "boom", truncated: true })),
    ).toBe('step 3 · called os.fs.read path="src/a.ts" · failed, 4 chars back (truncated)');
  });

  it("says when a call had no args or returned nothing", () => {
    expect(stepNoteLine(card({ args: {}, summary: "" }))).toBe(
      "step 3 · called os.fs.read no args · ok, nothing back",
    );
  });
});

describe("step note helpers", () => {
  it("sizes results in chars, switching to k at 1000", () => {
    expect(resultSizeLabel("")).toBe("nothing back");
    expect(resultSizeLabel("abc")).toBe("3 chars back");
    expect(resultSizeLabel("y".repeat(2500))).toBe("2.5k chars back");
  });

  it("clips long args to the limit", () => {
    const label = stepArgsLabel({ cmd: "z".repeat(200) }, 30);
    expect(label.length).toBeLessThanOrEqual(30);
    expect(label.endsWith("…")).toBe(true);
  });

  it("charges the note's row in the height estimate only when verbose", () => {
    const plain = estimateToolCardHeight(card({ summary: "one line" }));
    expect(estimateToolCardHeight(card({ summary: "one line" }), true)).toBe(plain + 1);
  });
});
