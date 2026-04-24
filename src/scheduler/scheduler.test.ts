import { describe, it, expect, vi } from "vitest";

import type { DrainOutcome } from "../tasks/task-runner.js";

import { Scheduler, type SchedulerClock, type SchedulerTaskRunner } from "./scheduler.js";

interface FakeTimer {
  handler: () => void;
  ms: number;
  cleared: boolean;
}

function createFakeClock(): { clock: SchedulerClock; timers: FakeTimer[]; nowMs: { value: number } } {
  const nowMs = { value: 1_000_000 };
  const timers: FakeTimer[] = [];
  const clock: SchedulerClock = {
    now: () => nowMs.value,
    setInterval: (handler, ms) => {
      const timer: FakeTimer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (handle) => {
      const timer = handle as FakeTimer;
      timer.cleared = true;
    },
  };
  return { clock, timers, nowMs };
}

function emptyOutcome(): DrainOutcome {
  return {
    drained: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    retried: 0,
  };
}

describe("Scheduler", () => {
  it("calls runDue with now() and batch on each tick", async () => {
    const { clock, timers, nowMs } = createFakeClock();
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockResolvedValue({ ...emptyOutcome(), drained: 2, completed: 2 });
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 5_000,
      batch: 10,
      clock,
    });

    scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(5_000);

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(runDue).toHaveBeenCalledWith(nowMs.value, 10);

    nowMs.value += 5_000;
    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(2);
    expect(runDue).toHaveBeenLastCalledWith(nowMs.value, 10);

    await scheduler.stop();
  });

  it("skips re-entry when a prior tick is still in flight", async () => {
    const { clock, timers } = createFakeClock();
    let resolveFirst!: (value: DrainOutcome) => void;
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockImplementationOnce(
        () =>
          new Promise<DrainOutcome>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(emptyOutcome());
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 5,
      clock,
    });

    scheduler.start();
    timers[0].handler();
    timers[0].handler();
    timers[0].handler();

    expect(runDue).toHaveBeenCalledTimes(1);

    resolveFirst({ ...emptyOutcome(), drained: 1, completed: 1 });
    await new Promise((r) => setImmediate(r));

    timers[0].handler();
    await vi.waitFor(() => expect(runDue).toHaveBeenCalledTimes(2));

    await scheduler.stop();
  });

  it("swallows tick errors and keeps the interval alive", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ...emptyOutcome(), drained: 1, completed: 1 });
    const warn = vi.fn();
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 5,
      clock,
      logger: {
        debug: () => {},
        info: () => {},
        warn,
        error: () => {},
      } as unknown as import("../tracing/structured-logger.js").StructuredLogger,
    });

    scheduler.start();
    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "scheduler tick failed",
      expect.objectContaining({ error: "boom" }),
    );
    expect(timers[0].cleared).toBe(false);

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("stop clears the interval and awaits the in-flight tick", async () => {
    const { clock, timers } = createFakeClock();
    let resolveTick!: (value: DrainOutcome) => void;
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockImplementation(
        () =>
          new Promise<DrainOutcome>((resolve) => {
            resolveTick = resolve;
          }),
      );
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 5,
      clock,
    });

    scheduler.start();
    timers[0].handler();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(timers[0].cleared).toBe(false);

    const stopPromise = scheduler.stop();
    expect(timers[0].cleared).toBe(true);

    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });

    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);

    resolveTick({ ...emptyOutcome(), drained: 1, completed: 1 });
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("start is a no-op after stop", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockResolvedValue(emptyOutcome());
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 5,
      clock,
    });

    scheduler.start();
    await scheduler.stop();
    scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0].cleared).toBe(true);
  });

  it("tickOnce runs a single drain regardless of the interval", async () => {
    const { clock } = createFakeClock();
    const runDue = vi
      .fn<Parameters<SchedulerTaskRunner["runDue"]>, ReturnType<SchedulerTaskRunner["runDue"]>>()
      .mockResolvedValue({ ...emptyOutcome(), drained: 3, completed: 3 });
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 7,
      clock,
    });

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(runDue).toHaveBeenCalledWith(expect.any(Number), 7);
  });
});
