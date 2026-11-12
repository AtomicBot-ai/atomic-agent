import { describe, expect, it } from "vitest";

import {
  checkWorkerFit,
  estimatedOutputTokens,
  estimateRows,
  FIT_REFUSE_FACTOR,
  formatEstimateMs,
  readOutputEstimate,
  renderEstimateBlock,
  TOKENS_PER_OUTPUT_LINE,
  type WorkerFitInput,
} from "./worker-fit.js";

const MIN = 60_000;

function fit(over: Partial<WorkerFitInput>): ReturnType<typeof checkWorkerFit> {
  return checkWorkerFit({
    tasks: [],
    tokensPerSecond: 5,
    concurrency: 1,
    budgetMsFor: () => 45 * MIN,
    maxBudgetMs: 4 * 45 * MIN,
    ...over,
  });
}

describe("readOutputEstimate", () => {
  it("returns nothing and no problem when both fields are absent", () => {
    const problems: string[] = [];
    expect(readOutputEstimate({}, "tasks[0]", problems)).toEqual({});
    expect(problems).toEqual([]);
  });

  it("floors a fractional value and names a bad one", () => {
    const problems: string[] = [];
    expect(
      readOutputEstimate({ outputTokens: 99.9, outputLines: -1 }, "tasks[2]", problems),
    ).toEqual({ outputTokens: 99 });
    expect(problems).toEqual(["tasks[2].outputLines must be a positive number"]);
  });
});

describe("estimatedOutputTokens", () => {
  it("prefers tokens, converts lines, and is null without either", () => {
    expect(estimatedOutputTokens({ outputTokens: 900, outputLines: 10 })).toBe(900);
    expect(estimatedOutputTokens({ outputLines: 1500 })).toBe(
      1500 * TOKENS_PER_OUTPUT_LINE,
    );
    expect(estimatedOutputTokens({})).toBeNull();
  });
});

describe("checkWorkerFit", () => {
  it("does nothing when the speed is unknown", () => {
    const result = fit({
      tokensPerSecond: null,
      tasks: [{ id: "big", outputTokens: 900_000 }],
    });
    expect(result.warnings.size).toBe(0);
    expect(result.refusal).toBeUndefined();
  });

  it("does nothing for a task without an estimate or one that fits", () => {
    // 6,000 tokens at 5 tok/s = 20 min, inside 45 min.
    const result = fit({
      tasks: [{ id: "plain" }, { id: "small", outputTokens: 6_000 }],
    });
    expect(result.warnings.size).toBe(0);
    expect(result.refusal).toBeUndefined();
  });

  it("warns, without refusing, when a task runs over its limit", () => {
    // 1,500 lines ≈ 15,000 tokens at 5 tok/s = 50 min > 45 min.
    const result = fit({ tasks: [{ id: "big", outputLines: 1500 }] });
    expect(result.refusal).toBeUndefined();
    const warning = result.warnings.get("big");
    expect(warning).toContain("~1,500 lines (~15,000 tokens) at 5 tok/s is ~50m");
    expect(warning).toContain("over its 45m limit");
    expect(warning).toContain("run anyway");
    expect(warning).toContain("give it timeoutMs of at least");
  });

  it("counts the workers sharing the GPU", () => {
    // 6,000 tokens = 20 min alone, 60 min with three at once.
    const result = fit({
      concurrency: 3,
      tasks: [{ id: "a", outputTokens: 6_000 }],
    });
    expect(result.warnings.get("a")).toContain("with 3 workers sharing the GPU is ~1h00m");
  });

  it("refuses only when no allowed limit could hold the task, even alone", () => {
    // 4× 45 min = 3 h. 60,000 tokens at 5 tok/s = 3h20m: refused.
    const over = fit({ tasks: [{ id: "huge", outputTokens: 60_000 }, { id: "ok" }] });
    expect(over.refused).toEqual(["huge"]);
    expect(over.refusal).toContain("fusion.delegate did not run");
    expect(over.refusal).toContain("[huge]");
    expect(over.refusal).toContain("Split each into smaller tasks");
    // Just under the longest limit: a warning, not a refusal.
    const under = fit({ tasks: [{ id: "big", outputTokens: 50_000 }] });
    expect(under.refusal).toBeUndefined();
    expect(under.warnings.has("big")).toBe(true);
    // Over the longest limit but within FIT_REFUSE_FACTOR × its own
    // (raised) limit: still only a warning.
    const raised = fit({
      budgetMsFor: () => 120 * MIN,
      tasks: [{ id: "big", outputTokens: 60_000 }],
    });
    expect(FIT_REFUSE_FACTOR).toBe(4);
    expect(raised.refusal).toBeUndefined();
    expect(raised.warnings.get("big")).toContain("split it into smaller tasks");
  });

  it("never suggests a timeoutMs above the longest allowed", () => {
    const result = fit({
      concurrency: 4,
      tasks: [{ id: "a", outputTokens: 40_000 }],
    });
    const match = /timeoutMs of at least (\d+)/.exec(result.warnings.get("a") ?? "");
    expect(Number(match?.[1])).toBeLessThanOrEqual(4 * 45 * MIN);
  });
});

describe("estimate vs actual", () => {
  it("lists only tasks that carried an estimate, with the time ratio", () => {
    const rows = estimateRows(
      [
        { id: "a", outputTokens: 6_000 },
        { id: "b", etaSeconds: 120 },
        { id: "c" },
      ],
      [
        { id: "a", durationMs: 30 * MIN, usage: { completionTokens: 7_200 } },
        { id: "b", durationMs: 4 * MIN },
        { id: "c", durationMs: MIN },
      ],
      5,
      1,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]).toEqual({
      id: "a",
      estimatedTokens: 6_000,
      estimatedMs: 20 * MIN,
      actualTokens: 7_200,
      actualMs: 30 * MIN,
    });
    const block = renderEstimateBlock(rows);
    expect(block).toContain("Estimates vs actual");
    expect(block).toContain(
      "- [a] estimated ~6,000 tokens, ~20m; actual 7,200 tokens out, 30m (1.5x the time estimate)",
    );
    expect(block).toContain("- [b] estimated ~2m00s; actual 4m00s (2.0x the time estimate)");
  });

  it("renders nothing when no task carried an estimate", () => {
    expect(
      renderEstimateBlock(estimateRows([{ id: "a" }], [{ id: "a", durationMs: 1 }], 5, 1)),
    ).toBe("");
  });

  it("states sizes without a time when the speed is unknown", () => {
    const rows = estimateRows(
      [{ id: "a", outputLines: 100 }],
      [{ id: "a", durationMs: 90_000 }],
      null,
      2,
    );
    expect(renderEstimateBlock(rows)).toContain(
      "- [a] estimated ~1,000 tokens; actual 1m30s",
    );
  });
});

describe("formatEstimateMs", () => {
  it("reads as seconds, minutes or hours", () => {
    expect(formatEstimateMs(40_000)).toBe("40s");
    expect(formatEstimateMs(80_000)).toBe("1m20s");
    expect(formatEstimateMs(12 * MIN)).toBe("12m");
    expect(formatEstimateMs(65 * MIN)).toBe("1h05m");
  });
});
