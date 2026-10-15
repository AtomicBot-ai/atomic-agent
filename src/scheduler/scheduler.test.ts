import { describe, it, expect, vi } from "vitest";

import type { DrainOutcome } from "../tasks/task-runner.js";

import {
  Scheduler,
  type SchedulerClock,
  type SchedulerTaskRunner,
} from "./scheduler.js";
import type { SchedulerLeadership } from "./scheduler-leadership.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";

interface FakeTimer {
  handler: () => void;
  ms: number;
  cleared: boolean;
}

function createFakeClock(): {
  clock: SchedulerClock;
  timers: FakeTimer[];
  nowMs: { value: number };
} {
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
      .fn<SchedulerTaskRunner["runDue"]>()
      .mockResolvedValue({ ...emptyOutcome(), drained: 2, completed: 2 });
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 5_000,
      batch: 10,
      clock,
    });

    scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(5_000);

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(runDue).toHaveBeenCalledWith(
      nowMs.value,
      10,
      expect.any(AbortSignal),
    );

    nowMs.value += 5_000;
    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(2);
    expect(runDue).toHaveBeenLastCalledWith(
      nowMs.value,
      10,
      expect.any(AbortSignal),
    );

    await scheduler.stop();
  });

  it("skips re-entry when a prior tick is still in flight", async () => {
    const { clock, timers } = createFakeClock();
    let resolveFirst!: (value: DrainOutcome) => void;
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
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
    timers[0]!.handler();
    timers[0]!.handler();
    timers[0]!.handler();

    expect(runDue).toHaveBeenCalledTimes(1);

    resolveFirst({ ...emptyOutcome(), drained: 1, completed: 1 });
    await new Promise((r) => setImmediate(r));

    timers[0]!.handler();
    await vi.waitFor(() => expect(runDue).toHaveBeenCalledTimes(2));

    await scheduler.stop();
  });

  it("swallows tick errors and keeps the interval alive", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
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
    expect(timers[0]!.cleared).toBe(false);

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("stop clears the interval and awaits the in-flight tick", async () => {
    const { clock, timers } = createFakeClock();
    let resolveTick!: (value: DrainOutcome) => void;
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
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
    timers[0]!.handler();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(timers[0]!.cleared).toBe(false);

    const stopPromise = scheduler.stop();
    expect(timers[0]!.cleared).toBe(true);

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

  it("stop aborts the in-flight tick's signal, so its task turn is stopped rather than waited out", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
      .mockImplementation(
        (_now, _limit, signal) =>
          new Promise<DrainOutcome>((resolve) => {
            // A drain whose task turn ends only when it is stopped.
            signal?.addEventListener(
              "abort",
              () => resolve({ ...emptyOutcome(), drained: 1, cancelled: 1 }),
              { once: true },
            );
          }),
      );
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 5,
      clock,
    });

    scheduler.start();
    timers[0]!.handler();
    const signal = runDue.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);

    await scheduler.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("stop(graceMs) stops waiting for a tick whose turn ignores its signal", async () => {
    const { clock, timers } = createFakeClock();
    let resolveTick!: (value: DrainOutcome) => void;
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
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
    timers[0]!.handler();
    await scheduler.stop(10);
    expect(timers[0]!.cleared).toBe(true);

    // Let the abandoned tick finish, so the test leaves nothing running.
    resolveTick(emptyOutcome());
  });

  it("start is a no-op after stop", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
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
    expect(timers[0]!.cleared).toBe(true);
  });

  it("tickOnce runs a single drain regardless of the interval", async () => {
    const { clock } = createFakeClock();
    const runDue = vi
      .fn<SchedulerTaskRunner["runDue"]>()
      .mockResolvedValue({ ...emptyOutcome(), drained: 3, completed: 3 });
    const scheduler = new Scheduler({
      taskRunner: { runDue },
      tickMs: 1_000,
      batch: 7,
      clock,
    });

    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(runDue).toHaveBeenCalledWith(
      expect.any(Number),
      7,
      expect.any(AbortSignal),
    );
  });
});

// ATO-416: with a shared state dir only the leader's interval ticks drain.
describe("Scheduler leadership gate", () => {
  function gate(initial: boolean): SchedulerLeadership & {
    leader: boolean;
    released: number;
  } {
    const state = {
      leader: initial,
      released: 0,
      isLeader: () => state.leader,
      release: () => {
        state.released += 1;
      },
    };
    return state;
  }

  it("interval ticks drain only while this process leads", async () => {
    const { clock, timers } = createFakeClock();
    const runDue = vi.fn<SchedulerTaskRunner["runDue"]>().mockResolvedValue(emptyOutcome());
    const leadership = gate(false);
    const scheduler = new Scheduler({ taskRunner: { runDue }, tickMs: 5_000, batch: 3, clock, leadership });
    scheduler.start();
    timers[0]!.handler();
    await Promise.resolve();
    expect(runDue).not.toHaveBeenCalled();
    leadership.leader = true;
    timers[0]!.handler();
    await Promise.resolve();
    expect(runDue).toHaveBeenCalledTimes(1);
    leadership.leader = false;
    timers[0]!.handler();
    await Promise.resolve();
    expect(runDue).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("an explicit tickOnce is never gated", async () => {
    const { clock } = createFakeClock();
    const runDue = vi.fn<SchedulerTaskRunner["runDue"]>().mockResolvedValue(emptyOutcome());
    const scheduler = new Scheduler({ taskRunner: { runDue }, tickMs: 5_000, batch: 3, clock, leadership: gate(false) });
    await scheduler.tickOnce();
    expect(runDue).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("stop releases leadership after the in-flight tick settles", async () => {
    const { clock, timers } = createFakeClock();
    let finish!: (value: DrainOutcome) => void;
    const runDue = vi.fn<SchedulerTaskRunner["runDue"]>().mockImplementation(
      () => new Promise<DrainOutcome>((resolve) => { finish = resolve; }),
    );
    const leadership = gate(true);
    const scheduler = new Scheduler({ taskRunner: { runDue }, tickMs: 5_000, batch: 3, clock, leadership });
    scheduler.start();
    timers[0]!.handler();
    await Promise.resolve();
    expect(runDue).toHaveBeenCalledTimes(1);
    const stopped = scheduler.stop();
    await Promise.resolve();
    expect(leadership.released).toBe(0);
    finish(emptyOutcome());
    await stopped;
    expect(leadership.released).toBe(1);
  });

  it("stop releases leadership even with nothing in flight", async () => {
    const { clock } = createFakeClock();
    const leadership = gate(true);
    const scheduler = new Scheduler({
      taskRunner: { runDue: vi.fn<SchedulerTaskRunner["runDue"]>().mockResolvedValue(emptyOutcome()) },
      tickMs: 5_000, batch: 3, clock, leadership,
    });
    scheduler.start();
    await scheduler.stop();
    expect(leadership.released).toBe(1);
  });

  it("logs hand-overs once and fails open when the gate throws", async () => {
    const { clock, timers } = createFakeClock();
    const records: LogRecord[] = [];
    const logger = new StructuredLogger({ level: "debug", sinks: [(record) => records.push(record)] });
    const runDue = vi.fn<SchedulerTaskRunner["runDue"]>().mockResolvedValue(emptyOutcome());
    let answer: boolean | Error = false;
    const scheduler = new Scheduler({
      taskRunner: { runDue }, tickMs: 5_000, batch: 3, clock, logger,
      leadership: {
        isLeader: () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
        release: () => {},
      },
    });
    scheduler.start();
    for (let i = 0; i < 3; i++) timers[0]!.handler();
    await Promise.resolve();
    expect(records.map((r) => r.message)).toEqual([
      "scheduler: another process runs due tasks; standing by",
    ]);
    answer = new Error("lock dir gone");
    timers[0]!.handler();
    await Promise.resolve();
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(records.map((r) => r.message)).toEqual([
      "scheduler: another process runs due tasks; standing by",
      "scheduler leadership check failed; running",
      "scheduler: running due tasks in this process",
    ]);
    await scheduler.stop();
  });
});
