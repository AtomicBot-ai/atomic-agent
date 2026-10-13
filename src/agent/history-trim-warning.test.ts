import { describe, expect, it } from "vitest";

import {
  HistoryTrimWarnings,
  reportHistoryTrim,
  type HistoryTrimStats,
  type HistoryTrimmedEvent,
} from "./history-trim-warning.js";

/**
 * ATO-295. The packer cut runs on every build and is sticky
 * (`conversationPackStart`), so the notice must reach the user once per
 * cut: again only when the dropped count changes, never once per step.
 */

const stats = (droppedTurns: number, droppedPairs = 1, boundBy: HistoryTrimStats["conversationBoundBy"] = "tokens"): HistoryTrimStats => ({
  droppedTurns,
  droppedPairs,
  conversationBoundBy: boundBy,
});

function run(steps: Array<[string, HistoryTrimStats]>): HistoryTrimmedEvent[] {
  const warnings = new HistoryTrimWarnings();
  const events: HistoryTrimmedEvent[] = [];
  steps.forEach(([sessionId, prompt], stepIndex) =>
    reportHistoryTrim({ warnings, sessionId, stepIndex, prompt, emit: (e) => events.push(e) }));
  return events;
}

describe("reportHistoryTrim", () => {
  it("says nothing while nothing is dropped", () => {
    expect(run([["s", stats(0, 0, null)], ["s", stats(0, 0, null)]])).toEqual([]);
  });

  it("reports a cut once while the dropped count stays the same", () => {
    const events = run([["s", stats(6, 2)], ["s", stats(6, 2)], ["s", stats(6, 2)]]);
    expect(events).toEqual([
      { type: "history_trimmed", stepIndex: 0, droppedMessages: 6, droppedTurns: 2, boundBy: "tokens" },
    ]);
  });

  it("reports again when the cut moves", () => {
    const events = run([["s", stats(6, 2)], ["s", stats(6, 2)], ["s", stats(9, 3, "pairs")]]);
    expect(events.map((e) => [e.stepIndex, e.droppedMessages, e.boundBy])).toEqual([[0, 6, "tokens"], [2, 9, "pairs"]]);
  });

  it("re-arms after a build that drops nothing, such as one after a compaction", () => {
    const events = run([["s", stats(6)], ["s", stats(0, 0, null)], ["s", stats(6)]]);
    expect(events.map((e) => e.stepIndex)).toEqual([0, 2]);
  });

  it("keeps sessions apart", () => {
    const events = run([["a", stats(6)], ["b", stats(6)], ["a", stats(6)]]);
    expect(events.map((e) => e.stepIndex)).toEqual([0, 1]);
  });

  it("defaults the bound to tokens when the prompt does not name one", () => {
    const [event] = run([["s", stats(4, 1, null)]]);
    expect(event?.boundBy).toBe("tokens");
  });
});
