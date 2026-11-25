import { describe, expect, it } from "vitest";

import {
  formatFusionLiveWorker,
  reduceFusionLiveWorkers,
} from "./fusion-live-workers.js";
import {
  clipRowTitle,
  describeOutcome,
  MAX_ROW_TITLE_CHARS,
} from "./fusion-worker-row-details.js";

const base = {
  type: "fusion_worker" as const,
  taskId: "ui",
  title: "UI",
  role: "worker" as const,
  model: "small",
};

describe("a worker row's steps, files, tokens and outcome (ATO-1364, ATO-78)", () => {
  it("shows steps against the budget, files written and reply tokens while it runs", () => {
    let rows = reduceFusionLiveWorkers([], { ...base, phase: "started", stepBudget: 40 }, 0);
    expect(formatFusionLiveWorker(rows[0]!, 1_000)).toBe(
      "UI · small — working · 1s · 0/40 steps",
    );
    rows = reduceFusionLiveWorkers(
      rows,
      { ...base, phase: "usage", stepCount: 12, stepBudget: 40, filesWritten: 3, tokens: 41_200, tokensOut: 3_200 },
      0,
    );
    expect(formatFusionLiveWorker(rows[0]!, 42_000)).toBe(
      "UI · small — working · 42s · 12/40 steps · 3 files · 41.2k tok (3.2k out)",
    );
  });

  it("keeps the progress when a later event omits it", () => {
    let rows = reduceFusionLiveWorkers(
      [],
      { ...base, phase: "usage", stepCount: 2, stepBudget: 8, filesWritten: 1 },
      0,
    );
    rows = reduceFusionLiveWorkers(rows, { ...base, phase: "tool", tool: "os.fs.read" }, 0);
    expect(rows[0]).toMatchObject({ stepCount: 2, stepBudget: 8, filesWritten: 1 });
    expect(formatFusionLiveWorker(rows[0]!, 0)).toContain("2/8 steps · 1 file");
  });

  it.each([
    ["needs_orchestrator", "returned to planner"],
    ["max_steps", "hit max steps"],
    ["timeout", "timed out"],
    ["ok", "done"],
    ["no_changes", "done, no changes"],
  ] as const)("says why a leg that ended with %s came back", (status, label) => {
    let rows = reduceFusionLiveWorkers([], { ...base, phase: "started", stepBudget: 8 }, 0);
    rows = reduceFusionLiveWorkers(
      rows,
      { ...base, phase: "finished", status, stepCount: 8, stepBudget: 8 },
      30_000,
    );
    expect(rows[0]).toMatchObject({ done: true, outcome: status });
    expect(formatFusionLiveWorker(rows[0]!, 99_000)).toBe(
      `UI · small — ${label} · 30s · 8/8 steps`,
    );
  });

  it("reads failed and cancelled off the phase when the end line has no status", () => {
    const failed = reduceFusionLiveWorkers([], { ...base, phase: "failed" }, 0);
    expect(failed[0]?.outcome).toBe("failed");
    expect(formatFusionLiveWorker(failed[0]!, 0)).toContain("— failed ·");
    const finished = reduceFusionLiveWorkers([], { ...base, phase: "finished" }, 0);
    expect(finished[0]?.outcome).toBeNull();
    expect(describeOutcome(finished[0]?.outcome)).toBe("done");
  });

  it("clips a long title so the model, clock and outcome stay on a narrow terminal", () => {
    const long = "Rewrite the whole settings screen so every toggle persists across restarts";
    const clipped = clipRowTitle(long);
    expect(clipped).toHaveLength(MAX_ROW_TITLE_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipRowTitle("  two\nlines  ")).toBe("two lines");
    const rows = reduceFusionLiveWorkers([], { ...base, title: long, phase: "started" }, 0);
    expect(formatFusionLiveWorker(rows[0]!, 0)).toBe(`${clipped} · small — working · 0s`);
  });

  it("puts the stuck flag before steps, and steps before spend and context", () => {
    const row = formatFusionLiveWorker(
      {
        taskId: "t",
        title: "T",
        model: "m",
        tool: null,
        done: false,
        startedAt: 0,
        finishedAt: null,
        etaSeconds: 60,
        contextTokens: 9_000,
        tokens: 20_000,
        stepCount: 3,
        stepBudget: 40,
      },
      19 * 60_000,
    );
    expect(row.indexOf("stuck")).toBeLessThan(row.indexOf("steps"));
    expect(row.indexOf("steps")).toBeLessThan(row.indexOf("tok"));
    expect(row.indexOf("tok")).toBeLessThan(row.indexOf("ctx"));
  });
});
