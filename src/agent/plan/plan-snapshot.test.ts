import { describe, expect, it } from "vitest";

import {
  cleanPlanStep,
  normalizePlanItems,
  parsePlanItemStatus,
  PLAN_MAX_ITEMS,
  PLAN_STEP_MAX_CHARS,
  planHasOpenItems,
  planProgress,
  planReminderNotice,
  readPlanSnapshot,
  renderPlanForModel,
  samePlanItems,
  type PlanSnapshot,
} from "./plan-snapshot.js";

const plan = (...statuses: Array<"pending" | "in_progress" | "done">): PlanSnapshot => ({
  items: statuses.map((status, i) => ({ step: `step ${i + 1}`, status })),
  updatedAt: 1,
});

describe("planProgress", () => {
  it("counts done steps and names the step in progress", () => {
    expect(planProgress(plan("done", "done", "in_progress", "pending"))).toEqual({
      done: 2,
      total: 4,
      current: "step 3",
    });
  });

  it("falls back to the first open step when none is marked in progress", () => {
    expect(planProgress(plan("done", "pending", "pending")).current).toBe("step 2");
  });

  it("has no current step once everything is done", () => {
    expect(planProgress(plan("done", "done"))).toEqual({ done: 2, total: 2 });
    expect(planHasOpenItems(plan("done", "done"))).toBe(false);
    expect(planHasOpenItems(null)).toBe(false);
  });
});

describe("normalizePlanItems", () => {
  it("accepts the canonical shape", () => {
    expect(normalizePlanItems([{ step: "Read", status: "done" }, { step: "Fix", status: "in_progress" }])).toEqual([
      { step: "Read", status: "done" },
      { step: "Fix", status: "in_progress" },
    ]);
  });

  it("reads the status words small models use", () => {
    expect(parsePlanItemStatus("completed")).toBe("done");
    expect(parsePlanItemStatus("In Progress")).toBe("in_progress");
    expect(parsePlanItemStatus("in-progress")).toBe("in_progress");
    expect(parsePlanItemStatus("todo")).toBe("pending");
    expect(parsePlanItemStatus("blocked")).toBeNull();
  });

  it("reads a bare string as a pending step and drops empty steps", () => {
    expect(normalizePlanItems(["Write tests", "  ", { step: "", status: "done" }])).toEqual([
      { step: "Write tests", status: "pending" },
    ]);
  });

  it("defaults a missing status to pending", () => {
    expect(normalizePlanItems([{ step: "Ship" }])).toEqual([{ step: "Ship", status: "pending" }]);
  });

  it("clears with an empty list", () => {
    expect(normalizePlanItems([])).toEqual([]);
  });

  it("refuses what it cannot read, with a message the model can act on", () => {
    expect(() => normalizePlanItems(undefined)).toThrow(/must be an array/);
    expect(() => normalizePlanItems([{ step: "x", status: "blocked" }])).toThrow(/"pending", "in_progress" or "done"/);
    expect(() => normalizePlanItems([42])).toThrow(/item 1/);
    expect(() => normalizePlanItems(Array.from({ length: PLAN_MAX_ITEMS + 1 }, (_, i) => `s${i}`))).toThrow(/at most/);
  });

  it("keeps steps on one line and cuts long ones", () => {
    expect(cleanPlanStep("a\n  b")).toBe("a b");
    const long = cleanPlanStep("x".repeat(PLAN_STEP_MAX_CHARS + 20));
    expect(long.length).toBe(PLAN_STEP_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("samePlanItems / readPlanSnapshot", () => {
  it("ignores the timestamp", () => {
    expect(samePlanItems(plan("done"), { ...plan("done"), updatedAt: 99 })).toBe(true);
    expect(samePlanItems(plan("done"), plan("pending"))).toBe(false);
    expect(samePlanItems(undefined, null)).toBe(true);
  });

  it("drops a malformed stored plan instead of throwing", () => {
    expect(readPlanSnapshot(null)).toBeNull();
    expect(readPlanSnapshot({ items: "nope" })).toBeNull();
    expect(readPlanSnapshot({ items: [{ step: "x", status: "weird" }] })).toBeNull();
    expect(readPlanSnapshot({ items: [] })).toBeNull();
    expect(readPlanSnapshot({ items: [{ step: "x", status: "done" }] })).toEqual({
      items: [{ step: "x", status: "done" }],
      updatedAt: 0,
    });
  });
});

describe("renderPlanForModel", () => {
  it("prints progress and one line per step", () => {
    expect(renderPlanForModel(plan("done", "in_progress", "pending"))).toBe(
      "Plan 1/3 done.\n[x] step 1\n[>] step 2\n[ ] step 3",
    );
    expect(renderPlanForModel({ items: [], updatedAt: 0 })).toBe("Plan cleared.");
  });
});

describe("planReminderNotice", () => {
  it("is silent without a plan or once the plan is complete", () => {
    expect(planReminderNotice(undefined)).toBeUndefined();
    expect(planReminderNotice(plan("done", "done"))).toBeUndefined();
  });

  it("names the open steps and how to keep or drop the plan", () => {
    const notice = planReminderNotice(plan("done", "in_progress", "pending"))!;
    expect(notice).toContain("1/3 done");
    expect(notice).toContain("[>] step 2");
    expect(notice).toContain("[ ] step 3");
    expect(notice).not.toContain("step 1");
    expect(notice).toContain("plan.update");
    expect(notice).toContain("items: []");
  });

  it("stays short on a long plan", () => {
    const notice = planReminderNotice(plan(...Array.from({ length: 12 }, () => "pending" as const)))!;
    expect(notice).toContain("…and 7 more");
    expect(notice.split("\n").length).toBeLessThanOrEqual(8);
  });
});
