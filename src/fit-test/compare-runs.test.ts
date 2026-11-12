import { describe, expect, it } from "vitest";
import { compareFitRuns, formatFitComparison, parseFitTestRun, pickModel } from "./compare-runs.js";
import { FIT_TEST_RUN_KIND, FIT_TEST_RUN_VERSION, type FitTaskResult, type FitTestRun } from "./fit-test-types.js";

function t(taskId: string, score: number | null, durationMs: number, tokens: number | null): FitTaskResult {
  return { taskId, score, reason: "", durationMs, tokens, timedOut: false };
}

function run(modelId: string, tasks: FitTaskResult[], taskSetCreatedAt = "set-1"): FitTestRun {
  return {
    kind: FIT_TEST_RUN_KIND,
    version: FIT_TEST_RUN_VERSION,
    createdAt: "x",
    taskSetCreatedAt,
    taskIds: tasks.map((task) => task.taskId),
    gpuBudgetGb: null,
    models: [{ modelId, loadError: null, loadMs: 0, peakMemoryBytes: null, tasks }],
  };
}

describe("compareFitRuns", () => {
  it("gives the score, time and token change per task and in total", () => {
    const before = run("base", [t("a", 3, 4000, 1000), t("b", 4, 2000, 500)]);
    const after = run("base+lora", [t("a", 5, 3000, 900), t("b", 4, 2500, 600)]);
    const c = compareFitRuns(before, after);
    expect(c.beforeModel).toBe("base");
    expect(c.afterModel).toBe("base+lora");
    expect(c.sameTaskSet).toBe(true);
    expect(c.tasks.map((d) => [d.taskId, d.scoreDelta, d.durationDeltaMs, d.tokensDelta])).toEqual([
      ["a", 2, -1000, -100],
      ["b", 0, 500, 100],
    ]);
    expect(c.total).toEqual({
      meanScoreBefore: 3.5,
      meanScoreAfter: 4.5,
      meanScoreDelta: 1,
      passedDelta: 1,
      durationDeltaMs: -500,
      tokensDelta: 0,
      unmatched: 0,
    });
  });

  it("keeps a task only one run has out of the totals", () => {
    const before = run("m", [t("a", 3, 1000, null), t("gone", 5, 9000, null)]);
    const after = run("m", [t("a", 4, 1000, null), t("new", 1, 9000, null)], "set-2");
    const c = compareFitRuns(before, after);
    expect(c.sameTaskSet).toBe(false);
    expect(c.total.unmatched).toBe(2);
    expect(c.total.meanScoreDelta).toBe(1);
    expect(c.total.durationDeltaMs).toBe(0);
    expect(c.total.tokensDelta).toBeNull();
    const text = formatFitComparison(c);
    expect(text).toContain("different task sets");
    expect(text).toMatch(/gone\s+5 -> missing/);
    expect(text).toContain("total: score 3.00 -> 4.00 (+1.00), passed +1, time 0.0s, tokens n/a");
  });

  it("picks a named model, else the first that loaded", () => {
    const r = run("a", []);
    r.models.unshift({ modelId: "broken", loadError: "x", loadMs: 0, peakMemoryBytes: null, tasks: [] });
    r.models.push({ modelId: "b", loadError: null, loadMs: 0, peakMemoryBytes: null, tasks: [] });
    expect(pickModel(r, null).modelId).toBe("a");
    expect(pickModel(r, "b").modelId).toBe("b");
    expect(() => pickModel(r, "zzz")).toThrow(/no model zzz/);
  });

  it("parses a run file and refuses something else", () => {
    const r = run("m", [t("a", 3, 1, 1)]);
    expect(parseFitTestRun(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(() => parseFitTestRun({ kind: "atomic-agent.fit-task-set" })).toThrow(/not a fit-test run/);
  });
});
