import { describe, it, expect } from "vitest";
import {
  WORKER_BUDGET_CEILING_FACTOR,
  WORKER_QUEUE_BUDGET_DIVISOR,
  clampTaskBudget,
  resolveQueueBudgetMs,
} from "./worker-runner.js";
import { classifyWorkerStatus, WORKER_STATUS_ORDER } from "./worker-result.js";
import { parseDelegateArgs, MAX_DELEGATE_TASKS } from "./delegate-args.js";

describe("per-task budgets", () => {
  it("keeps the configured default when the task asks for nothing", () => {
    expect(clampTaskBudget(undefined, 60)).toEqual({
      value: 60,
      clamped: false,
    });
  });

  it("honours a bigger budget the orchestrator asked for", () => {
    expect(clampTaskBudget(200, 60)).toEqual({ value: 200, clamped: false });
  });

  it("clamps at the ceiling factor and says so", () => {
    // 60 * 4 = 240; 1000 is a runaway, not a refusal.
    expect(clampTaskBudget(1000, 60)).toEqual({ value: 240, clamped: true });
    expect(WORKER_BUDGET_CEILING_FACTOR).toBe(4);
  });

  it("takes the ceiling from the CONFIGURED default, so raising config raises it", () => {
    expect(clampTaskBudget(1000, 250).value).toBe(1000);
    expect(clampTaskBudget(1_000_000, 250).value).toBe(1000);
  });

  it("never returns less than one step", () => {
    expect(clampTaskBudget(0.2, 60).value).toBe(1);
  });
});

describe("the queue budget", () => {
  it("is a third of the worker's own budget, not the global first-token wait", () => {
    // The shipped first-token budget is 30 min. A 45-min worker must not
    // be allowed to spend 30 of them waiting to be served.
    const fortyFive = 45 * 60_000;
    const thirtyMin = 30 * 60_000;
    expect(resolveQueueBudgetMs(fortyFive, thirtyMin)).toBe(
      Math.floor(fortyFive / WORKER_QUEUE_BUDGET_DIVISOR),
    );
    expect(resolveQueueBudgetMs(fortyFive, thirtyMin)).toBeLessThan(thirtyMin);
  });

  it("takes the smaller of the two when the configured wait is short", () => {
    const fortyFive = 45 * 60_000;
    expect(resolveQueueBudgetMs(fortyFive, 60_000)).toBe(60_000);
  });

  it("is always positive", () => {
    expect(resolveQueueBudgetMs(1, 30 * 60_000)).toBeGreaterThan(0);
  });
});

describe("a time ceiling is not a step ceiling", () => {
  // `timeout` is decided by `runOneTask`, which is the only caller that
  // knows whose clock fired — see worker-queue-clock.test.ts. What is
  // pinned here is that the classifier's own precedence did NOT move.
  it("leaves the classifier's precedence alone: a cancellation stays one", () => {
    expect(classifyWorkerStatus("cancelled", false, "time_ceiling")).toBe(
      "cancelled",
    );
  });

  it("still reports max_steps when the steps ran out", () => {
    expect(classifyWorkerStatus("max_steps", false, undefined)).toBe(
      "max_steps",
    );
  });

  it("keeps a plain cancellation a cancellation", () => {
    expect(classifyWorkerStatus("cancelled", false, undefined)).toBe(
      "cancelled",
    );
  });

  it("orders both new statuses in the head line", () => {
    expect(WORKER_STATUS_ORDER).toContain("timeout");
    expect(WORKER_STATUS_ORDER).toContain("queued");
  });
});

describe("delegate args", () => {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    instructions: `do ${id}`,
    ...extra,
  });

  it("carries per-task budgets through the parser", () => {
    const parsed = parseDelegateArgs({
      tasks: [task("a", { maxSteps: 200, timeoutMs: 900_000 })],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks[0]!.maxSteps).toBe(200);
    expect(parsed.tasks[0]!.timeoutMs).toBe(900_000);
  });

  it("leaves them absent when not asked for", () => {
    const parsed = parseDelegateArgs({ tasks: [task("a")] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks[0]!.maxSteps).toBeUndefined();
    expect(parsed.tasks[0]!.timeoutMs).toBeUndefined();
  });

  it("refuses a budget that is not a positive number", () => {
    const parsed = parseDelegateArgs({
      tasks: [task("a", { maxSteps: -3 })],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/maxSteps must be a positive number/);
  });

  it("does NOT refuse a budget that is merely too big — the runner clamps it", () => {
    const parsed = parseDelegateArgs({
      tasks: [task("a", { maxSteps: 100_000 })],
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts a 16-task plan and refuses a 17th", () => {
    expect(MAX_DELEGATE_TASKS).toBe(16);
    const ok = parseDelegateArgs({
      tasks: Array.from({ length: 16 }, (_, i) => task(`t${i}`)),
    });
    expect(ok.ok).toBe(true);
    const tooMany = parseDelegateArgs({
      tasks: Array.from({ length: 17 }, (_, i) => task(`t${i}`)),
    });
    expect(tooMany.ok).toBe(false);
  });
});
