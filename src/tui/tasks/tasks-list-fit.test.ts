import { describe, expect, it } from "vitest";
import {
  computeTaskListLayout,
  fitTaskListHints,
  formatTaskListHeader,
  formatTaskRowCells,
  taskRowWidth,
  TASK_LIST_HINTS,
} from "./tasks-list-fit.js";
import type { TaskSummaryRow } from "./tasks-panel-state.js";

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

function row(overrides: Partial<TaskSummaryRow> = {}): TaskSummaryRow {
  return {
    id: "t-1",
    status: "pending",
    origin: "cli",
    triggerSource: null,
    sessionId: "s-114e4b54-aba7-4264-9aff-07f86eebe388",
    userMessage:
      "task number 1 — do the thing that needs doing regularly, at length",
    scheduleKind: "cron",
    scheduleLabel: "cron: 0 1 * * * (Europe/Berlin)",
    recurring: true,
    scheduledFor: NOW + 7 * 3_600_000,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    ...overrides,
  };
}

/**
 * The panel widths the left rail actually leaves behind: 88 on a
 * 120-column terminal, 73 on a 100-column one, 78 once the rail
 * collapses at 80.
 */
const REAL_WIDTHS = [88, 78, 73];

describe("task list column layout", () => {
  for (const width of REAL_WIDTHS) {
    it(`fits a row into ${width} columns`, () => {
      const layout = computeTaskListLayout(width);
      expect(taskRowWidth(layout)).toBeLessThanOrEqual(width);
      // Every column an operator needs to tell two cron jobs apart
      // survives at the widths the app is actually used at.
      expect(layout.status).toBeGreaterThan(0);
      expect(layout.schedule).toBeGreaterThan(0);
      expect(layout.nextRun).toBeGreaterThan(0);
      expect(layout.message).toBeGreaterThan(0);
    });
  }

  it("never plans a row wider than the panel, at any width", () => {
    for (let width = 12; width <= 200; width += 1) {
      const layout = computeTaskListLayout(width);
      expect(taskRowWidth(layout)).toBeLessThanOrEqual(width);
    }
  });

  it("spends slack on the message column", () => {
    const narrow = computeTaskListLayout(88);
    const wide = computeTaskListLayout(140);
    expect(wide.message).toBeGreaterThan(narrow.message);
  });

  it("drops the session id before the schedule loses its expression", () => {
    const layout = computeTaskListLayout(56);
    expect(layout.session).toBe(0);
    expect(layout.schedule).toBeGreaterThan(0);
  });
});

describe("task row cells", () => {
  for (const width of REAL_WIDTHS) {
    it(`renders one line of exactly the planned width at ${width}`, () => {
      const layout = computeTaskListLayout(width);
      const cells = formatTaskRowCells(row(), layout, NOW);
      const line = [
        `▸ ${cells.status}`,
        cells.schedule,
        cells.nextRun,
        cells.session,
        cells.message,
      ]
        .filter((cell) => cell.length > 0)
        .join(" ");
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).not.toContain("\n");
    });
  }

  it("keeps the header aligned with its own columns", () => {
    const layout = computeTaskListLayout(88);
    const header = formatTaskListHeader(layout);
    const cells = formatTaskRowCells(row(), layout, NOW);
    expect(header.indexOf("status")).toBe(2);
    expect(header.indexOf("schedule")).toBe(2 + cells.status.length + 1);
    expect(header.length).toBeLessThanOrEqual(88);
  });

  it("truncates rather than wraps a long message", () => {
    const layout = computeTaskListLayout(73);
    const cells = formatTaskRowCells(
      row({ userMessage: "x".repeat(400) }),
      layout,
      NOW,
    );
    expect(cells.message.length).toBe(layout.message);
    expect(cells.message.endsWith("…")).toBe(true);
  });
});

describe("footer hints", () => {
  for (const width of REAL_WIDTHS) {
    it(`fits the hint strip on one line at ${width}`, () => {
      const hints = fitTaskListHints(width);
      expect(hints.length).toBeLessThanOrEqual(width);
      // The keys that let a newcomer act, not just look, always survive.
      expect(hints).toContain("Enter detail");
      expect(hints).toContain("n new");
      expect(hints).toContain("c cancel");
    });
  }

  it("keeps every hint when the panel is wide enough", () => {
    const hints = fitTaskListHints(200);
    for (const hint of TASK_LIST_HINTS) expect(hints).toContain(hint);
  });

  it("still names one key on an absurdly narrow panel", () => {
    const hints = fitTaskListHints(6);
    expect(hints.length).toBeLessThanOrEqual(6);
    expect(hints.length).toBeGreaterThan(0);
  });
});
