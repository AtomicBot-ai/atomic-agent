import { describe, expect, it } from "vitest";

import { reduceFusionLiveWorkers, type FusionLiveWorker } from "./fusion-live-workers.js";
import {
  collapseFusionLiveWorkers,
  formatCollapsedFusionWorker,
} from "./fusion-worker-summary.js";

const base = {
  type: "fusion_worker" as const,
  role: "worker" as const,
  model: "small",
};

describe("the collapsed rows a fan-out leaves after its turn", () => {
  it("gives each worker exactly one row, with its outcome and how far it got", () => {
    let rows: readonly FusionLiveWorker[] = [];
    rows = reduceFusionLiveWorkers(rows, { ...base, taskId: "ui", title: "UI", phase: "started", stepBudget: 40 }, 0);
    rows = reduceFusionLiveWorkers(rows, { ...base, taskId: "ui", title: "UI", phase: "tool", tool: "os.fs.edit" }, 1_000);
    rows = reduceFusionLiveWorkers(
      rows,
      { ...base, taskId: "ui", title: "UI", phase: "finished", status: "needs_orchestrator", stepCount: 20, stepBudget: 40, filesWritten: 1 },
      250_000,
    );
    rows = reduceFusionLiveWorkers(rows, { ...base, taskId: "api", title: "API", phase: "started", stepBudget: 40 }, 0);
    const collapsed = collapseFusionLiveWorkers(rows, 300_000);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.map(formatCollapsedFusionWorker)).toEqual([
      "UI · small — returned to planner · 4m10s · 20/40 steps · 1 file",
      // Still running when the turn ended: the turn took it down, and
      // its clock stops at the turn's end.
      "API · small — cancelled · 5m00s · 0/40 steps",
    ]);
    expect(collapsed.every((w) => w.collapsed === true && w.done && w.tool === null)).toBe(true);
  });

  it("keeps an already collapsed row as it was", () => {
    const rows = collapseFusionLiveWorkers(
      reduceFusionLiveWorkers([], { ...base, taskId: "t", title: "T", phase: "finished", status: "timeout" }, 10_000),
      20_000,
    );
    expect(collapseFusionLiveWorkers(rows, 99_000)).toEqual(rows);
    expect(formatCollapsedFusionWorker(rows[0]!)).toBe("T · small — timed out · 0s");
  });

  it("collapses nothing when there was no fan-out", () => {
    const empty: readonly FusionLiveWorker[] = [];
    expect(collapseFusionLiveWorkers(empty)).toBe(empty);
  });
});
