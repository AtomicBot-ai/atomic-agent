import { describe, expect, it } from "vitest";
import {
  cycleTasksFilter,
  filterAndSortTaskRows,
  listTasksFilterOrder,
} from "./tasks-filter.js";
import type { TaskSummaryRow } from "./tasks-panel-state.js";

const ROW_BASE: TaskSummaryRow = {
  id: "t-0",
  status: "pending",
  origin: "tui",
  triggerSource: "user",
  sessionId: "s-0",
  userMessage: "hello world",
  scheduleKind: "cron",
  scheduleLabel: "cron: 0 * * * *",
  recurring: true,
  scheduledFor: 1_700_000_000_000,
  createdAt: 1_699_999_000_000,
  updatedAt: 1_699_999_000_000,
  startedAt: null,
  completedAt: null,
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
};

function row(overrides: Partial<TaskSummaryRow>): TaskSummaryRow {
  return { ...ROW_BASE, ...overrides };
}

describe("filterAndSortTaskRows", () => {
  it("returns every row when filter=all and search is empty", () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2", recurring: false })];
    const result = filterAndSortTaskRows(rows, { status: "all", search: "" });
    expect(result.map((r) => r.id).sort()).toEqual(["t-1", "t-2"]);
  });

  it("sorts by scheduled_for ascending, nulls last, then created_at desc", () => {
    const rows = [
      row({ id: "a", scheduledFor: 200, createdAt: 1 }),
      row({ id: "b", scheduledFor: 100, createdAt: 2 }),
      row({ id: "c", scheduledFor: null, createdAt: 3 }),
      row({ id: "d", scheduledFor: null, createdAt: 4 }),
    ];
    const result = filterAndSortTaskRows(rows, { status: "all", search: "" });
    expect(result.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("narrows to a single status bucket", () => {
    const rows = [
      row({ id: "a", status: "pending" }),
      row({ id: "b", status: "completed" }),
    ];
    const result = filterAndSortTaskRows(rows, { status: "completed", search: "" });
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("recurring bucket includes every recurring row regardless of status", () => {
    const rows = [
      row({ id: "a", recurring: true, status: "running" }),
      row({ id: "b", recurring: false, status: "running" }),
    ];
    const result = filterAndSortTaskRows(rows, { status: "recurring", search: "" });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("search matches message, id and sessionId substrings", () => {
    const rows = [
      row({ id: "abc", userMessage: "ping", sessionId: "xyz" }),
      row({ id: "def", userMessage: "pong", sessionId: "qrs" }),
    ];
    expect(
      filterAndSortTaskRows(rows, { status: "all", search: "pong" }).map((r) => r.id),
    ).toEqual(["def"]);
    expect(
      filterAndSortTaskRows(rows, { status: "all", search: "xyz" }).map((r) => r.id),
    ).toEqual(["abc"]);
    expect(
      filterAndSortTaskRows(rows, { status: "all", search: "AbC" }).map((r) => r.id),
    ).toEqual(["abc"]);
  });
});

describe("cycleTasksFilter", () => {
  it("moves forward through the canonical order", () => {
    const order = listTasksFilterOrder();
    for (let i = 0; i < order.length; i += 1) {
      const current = order[i]!;
      const expected = order[(i + 1) % order.length];
      expect(cycleTasksFilter(current, 1)).toBe(expected);
    }
  });

  it("wraps backward past the first bucket", () => {
    expect(cycleTasksFilter("all", -1)).toBe("recurring");
  });
});
