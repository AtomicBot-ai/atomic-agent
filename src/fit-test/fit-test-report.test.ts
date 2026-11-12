import { describe, expect, it } from "vitest";
import { formatFitTable, summarizeModel } from "./fit-test-report.js";
import { FIT_TEST_RUN_KIND, FIT_TEST_RUN_VERSION, type FitModelResult, type FitTestRun } from "./fit-test-types.js";

function model(modelId: string, scores: Array<number | null>, peak: number | null): FitModelResult {
  return {
    modelId,
    loadError: null,
    loadMs: 0,
    peakMemoryBytes: peak,
    tasks: scores.map((score, i) => ({ taskId: `t${i}`, score, reason: "", durationMs: 1500, tokens: 100, timedOut: false })),
  };
}

const RUN: FitTestRun = {
  kind: FIT_TEST_RUN_KIND,
  version: FIT_TEST_RUN_VERSION,
  createdAt: "x",
  taskSetCreatedAt: "y",
  taskIds: ["t0", "t1"],
  gpuBudgetGb: 24,
  models: [
    model("small", [3, 2], 2_500_000_000),
    model("big", [5, 4], 9_000_000_000),
    { modelId: "gone", loadError: "not downloaded", loadMs: 0, peakMemoryBytes: null, tasks: [] },
  ],
};

describe("fit-test report", () => {
  it("summarizes score, passes, time and tokens", () => {
    expect(summarizeModel(RUN.models[1]!)).toMatchObject({ meanScore: 4.5, passed: 2, scored: 2, totalMs: 3000, tokens: 200 });
    expect(summarizeModel(model("x", [null], null)).meanScore).toBeNull();
  });

  it("prints the best model first and a failed load last", () => {
    const lines = formatFitTable(RUN).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^model\s+score\s+passed\s+time\s+peak memory$/);
    expect(lines[1]).toMatch(/^big\s+4\.50\s+2\/2\s+3\.0s\s+9\.0 GB\s+200 tokens$/);
    expect(lines[2]).toMatch(/^small\s+2\.50\s+0\/2/);
    expect(lines[3]).toContain("not loaded: not downloaded");
    expect(lines[4]).toBe("GPU memory budget on this machine: 24.0 GB");
  });
});
