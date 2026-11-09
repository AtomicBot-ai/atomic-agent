import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";
import type { RunTurnResult } from "../agent/agent-loop.js";

import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import type { TaskReport } from "./task-report.js";
import { TaskStore } from "./task-store.js";

/**
 * Per-task budgets on durable tasks (ATO-1108): the runner hands the
 * task's own ceilings to `runTurn`, adds what each run spent to the row,
 * and gives a retry only what earlier attempts left.
 */

type RunOptions = Parameters<TaskRunnerRuntime["runTurn"]>[2];

describe("TaskRunner budgets", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-runner-budget-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-budget", workingDir: "/tmp/work" });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runnerWith(
    results: Array<Partial<RunTurnResult>>,
    reports: TaskReport[] = [],
    extra: { budgetedMaxSteps?: number } = {},
  ): { runner: TaskRunner; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    let cursor = 0;
    const runtime: TaskRunnerRuntime = {
      runTurn: async (s, _message, options) => {
        seen.push(options);
        const next = results[cursor++] ?? {};
        return { session: s, reason: "reply", stepCount: 1, ...next };
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
      reportSink: (report) => {
        reports.push(report);
      },
      ...extra,
    });
    return { runner, seen };
  }

  it("passes the task's ceilings to runTurn and stores what the run spent", async () => {
    const reports: TaskReport[] = [];
    const { runner, seen } = runnerWith(
      [{ reason: "max_steps", stopCause: "cost_ceiling", spendUsd: 2.1 }],
      reports,
    );
    const task = store.create({
      sessionId: session.id,
      userMessage: "overnight",
      origin: "cli",
      maxAttempts: 1,
      maxCostUsd: 2,
      maxDurationMs: 8 * 3_600_000,
      notify: "telegram",
    });
    const final = await runner.runOne(task.id);
    expect(seen[0]).toMatchObject({
      taskMaxCostUsd: 2,
      taskMaxDurationMs: 8 * 3_600_000,
    });
    expect(final?.status).toBe("completed");
    expect(final?.spentUsd).toBeCloseTo(2.1, 6);
    expect(store.get(task.id)?.spentUsd).toBeCloseTo(2.1, 6);
    expect(reports[0]).toMatchObject({ spentUsd: 2.1, maxCostUsd: 2 });
  });

  it("stores which ceiling ended a completed run", async () => {
    const { runner } = runnerWith([{ reason: "max_steps", stopCause: "time_ceiling" }]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "capped",
      origin: "cli",
      maxAttempts: 1,
      maxDurationMs: 60_000,
    });
    const final = await runner.runOne(task.id);
    expect(final?.status).toBe("completed");
    expect(final?.stopCause).toBe("time_ceiling");
  });

  it("stores no stop cause for a run that finished on its own", async () => {
    const { runner } = runnerWith([{}]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "done",
      origin: "cli",
      maxAttempts: 1,
    });
    const final = await runner.runOne(task.id);
    expect(final?.status).toBe("completed");
    expect(final?.stopCause).toBeNull();
  });

  it("passes no ceilings for a task without its own, so config decides", async () => {
    const { runner, seen } = runnerWith([{ spendUsd: 0 }]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "plain",
      origin: "cli",
      maxAttempts: 1,
    });
    const final = await runner.runOne(task.id);
    expect(seen[0]).not.toHaveProperty("taskMaxCostUsd");
    expect(seen[0]).not.toHaveProperty("taskMaxDurationMs");
    expect(final?.spentUsd).toBe(0);
  });

  it("gives a budgeted task without maxSteps the task-wide step ceiling", async () => {
    const { runner, seen } = runnerWith([{}, {}, {}], [], { budgetedMaxSteps: 1000 });
    const base = { sessionId: session.id, userMessage: "x", origin: "cli" as const, maxAttempts: 1 };
    await runner.runOne(store.create({ ...base, maxCostUsd: 5 }).id);
    await runner.runOne(store.create({ ...base, maxDurationMs: 60_000 }).id);
    await runner.runOne(store.create({ ...base, maxCostUsd: 5, maxSteps: 7 }).id);
    expect(seen.map((options) => options.maxSteps)).toEqual([1000, 1000, 7]);
  });

  it("keeps the per-leg default for a task without a budget", async () => {
    const { runner, seen } = runnerWith([{}], [], { budgetedMaxSteps: 1000 });
    await runner.runOne(
      store.create({ sessionId: session.id, userMessage: "x", origin: "cli", maxAttempts: 1 }).id,
    );
    expect(seen[0]?.maxSteps).toBe(5);
  });

  it("gives a retry only what earlier attempts left of the budget", async () => {
    const { runner, seen } = runnerWith([
      { reason: "failed", spendUsd: 1.5 },
      { reason: "reply", spendUsd: 0.25 },
    ]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "retry me",
      origin: "cli",
      maxAttempts: 3,
      maxCostUsd: 2,
    });
    const afterFirst = await runner.runOne(task.id);
    expect(afterFirst?.status).toBe("pending");
    expect(afterFirst?.spentUsd).toBeCloseTo(1.5, 6);
    const afterSecond = await runner.runOne(task.id);
    expect(seen[1]?.taskMaxCostUsd).toBeCloseTo(0.5, 6);
    expect(afterSecond?.status).toBe("completed");
    expect(afterSecond?.spentUsd).toBeCloseTo(1.75, 6);
  });

  it("gives a resumed task only the time earlier runs left", async () => {
    const { runner, seen } = runnerWith([{}]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "resume me",
      origin: "cli",
      maxAttempts: 1,
      maxDurationMs: 8 * 3_600_000,
    });
    store.recordElapsed(task.id, 7 * 3_600_000);
    await runner.runOne(task.id);
    expect(seen[0]?.taskMaxDurationMs).toBe(3_600_000);
  });

  it("adds the run's time to what earlier runs used", async () => {
    const { runner } = runnerWith([{}]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "timed",
      origin: "cli",
      maxAttempts: 1,
      maxDurationMs: 60_000,
    });
    store.recordElapsed(task.id, 1_000);
    const final = await runner.runOne(task.id);
    expect(final?.elapsedMs).toBeGreaterThanOrEqual(1_000);
  });

  it("does not track time for a task without a time limit", async () => {
    const { runner } = runnerWith([{}]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "untimed",
      origin: "cli",
      maxAttempts: 1,
    });
    const final = await runner.runOne(task.id);
    expect(final?.elapsedMs).toBeNull();
  });

  it("blocks a task whose time earlier runs already used up, without running it", async () => {
    const { runner, seen } = runnerWith([{}]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "out of time",
      origin: "cli",
      maxAttempts: 1,
      maxDurationMs: 3_600_000,
    });
    store.recordElapsed(task.id, 3_600_000);
    const final = await runner.runOne(task.id);
    expect(seen).toHaveLength(0);
    expect(final?.status).toBe("blocked");
    expect(final?.lastError).toMatch(/^time_spent: 60 min of 60 min/);
  });

  it("blocks a retry whose budget earlier attempts already used up, without running it", async () => {
    const { runner, seen } = runnerWith([{ reason: "failed", spendUsd: 2.4 }]);
    const task = store.create({
      sessionId: session.id,
      userMessage: "expensive",
      origin: "cli",
      maxAttempts: 3,
      maxCostUsd: 2,
    });
    await runner.runOne(task.id);
    const blocked = await runner.runOne(task.id);
    expect(seen).toHaveLength(1);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.lastError).toMatch(/^budget_spent: \$2\.40 of \$2\.00/);
  });

  it("keeps the spend of a run that threw, step by step, for the next attempt", async () => {
    const runtime: TaskRunnerRuntime = {
      runTurn: async (_s, _message, options) => {
        options.eventHook?.({ type: "step_finished", stepIndex: 0, summary: "read", durationMs: 1, spendUsd: 0.7 });
        options.eventHook?.({ type: "step_finished", stepIndex: 1, summary: "read", durationMs: 1, spendUsd: 1.2 });
        throw new Error("runtime fell over mid-turn");
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const task = store.create({
      sessionId: session.id,
      userMessage: "throws",
      origin: "cli",
      maxAttempts: 3,
      maxCostUsd: 2,
    });
    await runner.runOne(task.id);
    expect(store.get(task.id)?.spentUsd).toBeCloseTo(1.2, 6);
  });
});
