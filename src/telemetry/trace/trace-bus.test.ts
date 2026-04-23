import { describe, expect, it } from "vitest";

import { createTraceBus } from "./trace-bus.js";
import type { TraceEvent } from "./trace-event.js";

function makeEvent(seq: number): TraceEvent {
  return {
    type: "step_started",
    sessionId: "s",
    seq,
    ts: 0,
    turnIndex: 0,
    stepIndex: seq,
  };
}

describe("createTraceBus", () => {
  it("fans events out to every sink in order", () => {
    const a: TraceEvent[] = [];
    const b: TraceEvent[] = [];
    const bus = createTraceBus([(e) => a.push(e), (e) => b.push(e)]);
    bus.emit(makeEvent(0));
    bus.emit(makeEvent(1));
    expect(a.map((e) => e.seq)).toEqual([0, 1]);
    expect(b.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("swallows sink errors so siblings still receive events", () => {
    const seen: TraceEvent[] = [];
    const bus = createTraceBus([
      () => {
        throw new Error("sink failure");
      },
      (e) => seen.push(e),
    ]);
    expect(() => bus.emit(makeEvent(0))).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
