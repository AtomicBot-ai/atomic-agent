import { describe, expect, it } from "vitest";
import {
  countRunningTasks,
  selectSidebarTasks,
  SIDEBAR_TASKS_LIMIT,
} from "./sidebar-tasks-selector.js";
import type { TaskSummaryRow } from "./tasks/tasks-panel-state.js";

function row(overrides: Partial<TaskSummaryRow>): TaskSummaryRow {
  return {
    id: "x",
    status: "pending",
    origin: "tui",
    triggerSource: null,
    sessionId: null,
    userMessage: "",
    scheduleKind: null,
    scheduleLabel: "-",
    recurring: false,
    scheduledFor: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    ...overrides,
  };
}

describe("selectSidebarTasks", () => {
  it("keeps pending and running tasks, drops one-shot completed", () => {
    const result = selectSidebarTasks([
      row({ id: "a", status: "pending" }),
      row({ id: "b", status: "running" }),
      row({ id: "c", status: "completed" }),
    ]);
    expect(result.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("keeps recurring tasks regardless of status", () => {
    const result = selectSidebarTasks([
      row({ id: "rec-completed", status: "completed", recurring: true }),
      row({ id: "rec-failed", status: "failed", recurring: true }),
      row({ id: "one-shot-completed", status: "completed", recurring: false }),
    ]);
    expect(result.map((r) => r.id)).toEqual([
      "rec-failed",
      "rec-completed",
    ]);
  });

  it("orders running before pending before everything else", () => {
    const result = selectSidebarTasks([
      row({ id: "p", status: "pending", updatedAt: 5 }),
      row({ id: "rec", status: "blocked", recurring: true, updatedAt: 6 }),
      row({ id: "r", status: "running", updatedAt: 1 }),
    ]);
    expect(result.map((r) => r.id)).toEqual(["r", "p", "rec"]);
  });

  it("ties broken by updatedAt desc within the same status bucket", () => {
    const result = selectSidebarTasks([
      row({ id: "old", status: "pending", updatedAt: 1 }),
      row({ id: "new", status: "pending", updatedAt: 100 }),
      row({ id: "mid", status: "pending", updatedAt: 50 }),
    ]);
    expect(result.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps the result at SIDEBAR_TASKS_LIMIT", () => {
    const many = Array.from({ length: SIDEBAR_TASKS_LIMIT + 5 }, (_, i) =>
      row({ id: `t-${i}`, status: "pending", updatedAt: i }),
    );
    const result = selectSidebarTasks(many);
    expect(result).toHaveLength(SIDEBAR_TASKS_LIMIT);
  });
});

describe("countRunningTasks", () => {
  it("counts every running row, including the ones the rail truncates", () => {
    const rows = Array.from({ length: SIDEBAR_TASKS_LIMIT + 2 }, (_, i) =>
      row({ id: `r-${i}`, status: "running", updatedAt: i }),
    );
    // The projection tops out at the cap; the counter must not.
    expect(selectSidebarTasks(rows)).toHaveLength(SIDEBAR_TASKS_LIMIT);
    expect(countRunningTasks(rows)).toBe(SIDEBAR_TASKS_LIMIT + 2);
  });

  it("ignores rows in every other status", () => {
    expect(
      countRunningTasks([
        row({ id: "a", status: "pending" }),
        row({ id: "b", status: "completed", recurring: true }),
        row({ id: "c", status: "failed" }),
      ]),
    ).toBe(0);
  });
});
