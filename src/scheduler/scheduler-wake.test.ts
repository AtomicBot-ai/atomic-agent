import { describe, expect, it, vi } from "vitest";

import type { DrainOutcome } from "../tasks/task-runner.js";
import { Scheduler, type SchedulerClock, type SchedulerTaskRunner } from "./scheduler.js";

/** ATO-592: `poke()` on wake, and the `always` keep-awake hold. */

const EMPTY: DrainOutcome = { drained: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, retried: 0 };

function clock(): SchedulerClock {
  return {
    now: () => 1_000,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

function scheduler(extra: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  const runDue = vi.fn<SchedulerTaskRunner["runDue"]>().mockResolvedValue(EMPTY);
  const s = new Scheduler({ taskRunner: { runDue }, tickMs: 5_000, batch: 10, clock: clock(), ...extra });
  return { s, runDue };
}

describe("Scheduler.poke", () => {
  it("does nothing before start or after stop", async () => {
    const { s, runDue } = scheduler();
    expect(s.poke()).toBe(false);
    s.start();
    await s.stop();
    expect(s.poke()).toBe(false);
    expect(runDue).not.toHaveBeenCalled();
  });

  it("runs a tick at once while started", async () => {
    const { s, runDue } = scheduler();
    s.start();
    expect(s.poke()).toBe(true);
    await vi.waitFor(() => expect(runDue).toHaveBeenCalledTimes(1));
    await s.stop();
  });

  it("does not start a second tick while one is running", async () => {
    let finish: () => void = () => {};
    const runDue = vi.fn<SchedulerTaskRunner["runDue"]>(
      () => new Promise<DrainOutcome>((resolve) => { finish = () => resolve(EMPTY); }),
    );
    const s = new Scheduler({ taskRunner: { runDue }, tickMs: 5_000, batch: 10, clock: clock() });
    s.start();
    expect(s.poke()).toBe(true);
    expect(s.poke()).toBe(false);
    finish();
    await s.stop();
    expect(runDue).toHaveBeenCalledTimes(1);
  });

  it("respects leadership: another process runs due tasks", async () => {
    const { s, runDue } = scheduler({
      leadership: { isLeader: () => false, release: () => {} },
    });
    s.start();
    expect(s.poke()).toBe(false);
    await s.stop();
    expect(runDue).not.toHaveBeenCalled();
  });
});

describe("Scheduler keep-awake", () => {
  it("starts the keep-awake with the scheduler and stops it on stop", async () => {
    const keepAwake = { start: vi.fn(), stop: vi.fn() };
    const { s } = scheduler({ keepAwake });
    s.start();
    expect(keepAwake.start).toHaveBeenCalledTimes(1);
    expect(keepAwake.stop).not.toHaveBeenCalled();
    await s.stop();
    expect(keepAwake.stop).toHaveBeenCalledTimes(1);
  });
});
