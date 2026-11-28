import { describe, expect, it, vi } from "vitest";
import type { DrainOutcome } from "../tasks/task-runner.js";
import { Scheduler, type SchedulerClock } from "./scheduler.js";
import type { SchedulerLeadership } from "./scheduler-leadership.js";

// ATO-2508: what a former leader does between losing the lock and its
// next tick (file trigger hits re-ask leadership; sidecar ticks abort).

const outcome: DrainOutcome = { drained: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, retried: 0 };

function setup(options: { gate?: boolean; sidecar?: (now: number, signal: AbortSignal) => Promise<void> } = {}) {
  const handlers: Array<() => void> = [];
  const clock: SchedulerClock = {
    now: () => 1_000_000,
    setInterval: (handler) => {
      handlers.push(handler);
      return handlers.length;
    },
    clearInterval: () => {},
  };
  const state = { leader: true };
  const leadership: SchedulerLeadership = { isLeader: () => state.leader, release: () => {} };
  const seen: boolean[] = [];
  const scheduler = new Scheduler({
    taskRunner: { runDue: vi.fn().mockResolvedValue(outcome) },
    tickMs: 5_000,
    batch: 1,
    clock,
    ...(options.gate === false ? {} : { leadership }),
    onLeadershipChange: (leading) => {
      seen.push(leading);
    },
    ...(options.sidecar ? { sidecars: [{ tick: options.sidecar }] } : {}),
  });
  scheduler.start();
  return { scheduler, state, seen, tick: () => handlers[0]!() };
}

describe("Scheduler.confirmLeadership (ATO-2508)", () => {
  it("answers false as soon as the lock moved, and stands this process by without waiting for a tick", async () => {
    const t = setup();
    t.tick();
    expect(t.scheduler.confirmLeadership()).toBe(true);
    expect(t.seen).toEqual([true]);
    t.state.leader = false;
    expect(t.scheduler.confirmLeadership()).toBe(false);
    expect(t.seen).toEqual([true, false]);
    // The next tick finds nothing new to report.
    t.tick();
    expect(t.seen).toEqual([true, false]);
    await t.scheduler.stop();
  });

  it("never takes leadership it did not already have", async () => {
    const t = setup();
    // Before the first tick: no answer yet.
    expect(t.scheduler.confirmLeadership()).toBe(false);
    t.state.leader = false;
    t.tick();
    t.state.leader = true;
    expect(t.scheduler.confirmLeadership()).toBe(false);
    expect(t.seen).toEqual([false]);
    await t.scheduler.stop();
  });

  it("is false once stop began", async () => {
    const t = setup();
    t.tick();
    const stopping = t.scheduler.stop();
    expect(t.scheduler.confirmLeadership()).toBe(false);
    await stopping;
  });

  it("is true for a single process without a gate", async () => {
    const t = setup({ gate: false });
    t.tick();
    expect(t.scheduler.confirmLeadership()).toBe(true);
    await t.scheduler.stop();
  });
});

describe("Scheduler sidecar signal per leadership term (ATO-2508)", () => {
  it("aborts a running sidecar tick when this process stops leading, before stop()", async () => {
    const signals: AbortSignal[] = [];
    const t = setup({
      sidecar: async (_now, signal) => {
        signals.push(signal);
      },
    });
    t.tick(); // gains leadership: sidecars wait one tick (#1735)
    t.tick(); // first sidecar tick
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    t.state.leader = false;
    t.tick(); // stands by
    expect(signals[0]!.aborted).toBe(true);
    await t.scheduler.stop();
  });

  it("hands a fresh signal to the sidecars after leadership comes back", async () => {
    const signals: AbortSignal[] = [];
    const t = setup({
      sidecar: async (_now, signal) => {
        signals.push(signal);
      },
    });
    t.tick();
    t.tick();
    t.state.leader = false;
    t.tick();
    t.state.leader = true;
    t.tick(); // regains: waits one tick
    t.tick();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await t.scheduler.stop();
    expect(signals[1]!.aborted).toBe(true);
  });
});
