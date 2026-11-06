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
});
