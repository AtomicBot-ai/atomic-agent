import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { PlanSnapshot } from "../../agent/plan/plan-snapshot.js";
import { PlanStrip, planStatusTag, planStripLayout } from "./plan-strip.js";

const plan = (...statuses: Array<"pending" | "in_progress" | "done">): PlanSnapshot => ({
  items: statuses.map((status, i) => ({ step: `step ${i + 1}`, status })),
  updatedAt: 1,
});

describe("PlanStrip", () => {
  it("renders nothing without a plan", () => {
    expect(render(<PlanStrip plan={null} />).lastFrame()?.trim()).toBe("");
    expect(render(<PlanStrip plan={{ items: [], updatedAt: 0 }} />).lastFrame()?.trim()).toBe("");
  });

  it("shows progress and the steps with ticks on finished ones", () => {
    const frame = render(<PlanStrip plan={plan("done", "in_progress", "pending")} width={80} />).lastFrame() ?? "";
    expect(frame).toContain("plan 1/3");
    expect(frame).toContain("✓ step 1");
    expect(frame).toContain("▸ step 2");
    expect(frame).toContain("○ step 3");
  });

  it("collapses a finished plan to its header", () => {
    const frame = render(<PlanStrip plan={plan("done", "done")} width={80} />).lastFrame() ?? "";
    expect(frame).toContain("plan 2/2");
    expect(frame).toContain("done");
    expect(frame).not.toContain("step 1");
  });
});

describe("planStripLayout", () => {
  it("keeps the step in progress in view and counts the rest", () => {
    const layout = planStripLayout(plan("done", "done", "done", "done", "in_progress", "pending", "pending", "pending", "pending"), 5);
    expect(layout.rows.map((r) => r.item.step)).toEqual(["step 4", "step 5", "step 6", "step 7", "step 8"]);
    expect(layout.doneAbove).toBe(3);
    expect(layout.moreBelow).toBe(1);
  });

  it("does not leave empty rows when the list ends early", () => {
    const layout = planStripLayout(plan("done", "done", "done", "done", "done", "in_progress"), 5);
    expect(layout.rows.map((r) => r.item.step)).toEqual(["step 2", "step 3", "step 4", "step 5", "step 6"]);
    expect(layout.doneAbove).toBe(1);
    expect(layout.moreBelow).toBe(0);
  });
});

describe("planStatusTag", () => {
  it("reads plan done/total", () => {
    expect(planStatusTag(plan("done", "pending", "pending"))).toBe("plan 1/3");
    expect(planStatusTag(null)).toBeNull();
  });
});
