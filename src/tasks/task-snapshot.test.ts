import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { createTaskRunSummaryCollector } from "./task-run-summary.js";
import { startTaskSnapshots, type TaskSnapshotSink } from "./task-snapshot.js";

// ATO-965: auto snapshots of a long reporting task.

const MIN = 60_000;

function step(i: number): AgentLoopEvent {
  return { type: "step_finished", stepIndex: i, summary: `step ${i}`, durationMs: 1 } as AgentLoopEvent;
}

function setup(cadence: { everySteps: number; everyMs: number }) {
  let clock = 0;
  let tick: (() => void) | null = null;
  const stopTimer = vi.fn();
  const sink: TaskSnapshotSink & { updates: number[] } = {
    updates: [],
    update: vi.fn((status) => {
      sink.updates.push(status.summary.steps);
    }),
    end: vi.fn(),
  };
  const collector = createTaskRunSummaryCollector();
  const loop = startTaskSnapshots({
    sink,
    cadence,
    live: { taskId: "t1", userMessage: "nightly", startedAt: 0 },
    collector,
    now: () => clock,
    schedule: (cb) => {
      tick = cb;
      return stopTimer;
    },
  });
  const feed = (event: AgentLoopEvent): void => {
    collector.onEvent(event);
    loop?.onEvent(event);
  };
  return {
    loop,
    sink,
    feed,
    stopTimer,
    advance: (ms: number) => {
      clock += ms;
      tick?.();
    },
  };
}

describe("startTaskSnapshots", () => {
  it("sends the live status every N steps, with the collector's own counts", () => {
    const t = setup({ everySteps: 3, everyMs: 0 });
    for (let i = 0; i < 7; i++) t.feed(step(i));
    expect(t.sink.updates).toEqual([3, 6]);
    expect(t.sink.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: "t1", userMessage: "nightly", startedAt: 0 }),
    );
  });

  it("sends on the time trigger even while one long step runs", () => {
    const t = setup({ everySteps: 0, everyMs: 5 * MIN });
    t.feed(step(0));
    t.advance(4 * MIN);
    expect(t.sink.update).not.toHaveBeenCalled();
    t.advance(MIN);
    expect(t.sink.updates).toEqual([1]);
  });

  it("closes the sink's message at the end, only when a snapshot went out", () => {
    const quiet = setup({ everySteps: 10, everyMs: 0 });
    quiet.feed(step(0));
    quiet.loop!.stop();
    expect(quiet.sink.end).not.toHaveBeenCalled();

    const loud = setup({ everySteps: 1, everyMs: 5 * MIN });
    loud.feed(step(0));
    loud.loop!.stop();
    loud.loop!.stop();
    expect(loud.sink.end).toHaveBeenCalledTimes(1);
    expect(loud.sink.end).toHaveBeenCalledWith("t1");
    expect(loud.stopTimer).toHaveBeenCalledTimes(1);
    loud.feed(step(1));
    expect(loud.sink.updates).toEqual([1]);
  });

  it("is off when both triggers are 0", () => {
    expect(setup({ everySteps: 0, everyMs: 0 }).loop).toBeNull();
  });

  it("never lets a throwing sink reach the run", async () => {
    const onError = vi.fn();
    const loop = startTaskSnapshots({
      sink: {
        update: () => {
          throw new Error("boom");
        },
        end: () => Promise.reject(new Error("gone")),
      },
      cadence: { everySteps: 1, everyMs: 0 },
      live: { taskId: "t", userMessage: "m", startedAt: 0 },
      collector: createTaskRunSummaryCollector(),
      onError,
    })!;
    expect(() => loop.onEvent(step(0))).not.toThrow();
    loop.stop();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});
