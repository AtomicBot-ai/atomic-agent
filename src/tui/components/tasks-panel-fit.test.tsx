import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import React from "react";
import { TasksPanel } from "./tasks-panel.js";
import {
  createInitialTasksPanelState,
  type TaskSummaryRow,
  type TasksPanelState,
} from "../tasks/tasks-panel-state.js";

/**
 * Regression guard for the "Tasks screen is completely broken" report.
 *
 * The table laid its columns out to ~123 characters regardless of the
 * panel's real width, so under the permanent left rail (88 columns at
 * 120×40, 73 at 100×30) every row wrapped onto a second line. That
 * collided the columns into each other and doubled the table's height —
 * and Ink 7 does not clip an over-tall frame, it paints later lines
 * over earlier ones, so the filter bar and the column header were
 * overwritten by task text.
 *
 * The invariant is therefore about *lines*, not characters: one task
 * must occupy exactly one row of the frame.
 */

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

/** Panel widths the rail leaves at 120×40, 80×24 and 100×30. */
const REAL_WIDTHS = [88, 78, 73];

function taskRow(index: number): TaskSummaryRow {
  return {
    id: `t-${index}`,
    status: "pending",
    origin: "cli",
    triggerSource: null,
    sessionId: `s-${index}0e7169e-7491-418b-9a1d-6b4a2f0d1c33`,
    userMessage: `task number ${index} — do the thing that needs doing regularly`,
    scheduleKind: "cron",
    scheduleLabel: `cron: 0 ${index} * * * (Europe/Berlin)`,
    recurring: true,
    scheduledFor: NOW + index * 3_600_000,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
  };
}

function panelWithRows(count: number): TasksPanelState {
  return {
    ...createInitialTasksPanelState(),
    rows: Array.from({ length: count }, (_, i) => taskRow(i + 1)),
    lastRefreshedAt: NOW,
  };
}

function frameFor(width: number, rowCount: number, maxRows: number): string[] {
  const { lastFrame } = render(
    <Box width={width}>
      <TasksPanel
        panel={panelWithRows(rowCount)}
        now={NOW}
        maxRows={maxRows}
        width={width}
      />
    </Box>,
  );
  return (lastFrame() ?? "").split("\n");
}

describe("Tasks list rows stay on one line", () => {
  for (const width of REAL_WIDTHS) {
    it(`draws one line per task at width ${width}`, () => {
      const rowCount = 6;
      const lines = frameFor(width, rowCount, rowCount);
      // filter bar + header + rows + blank spacer + hints.
      expect(lines.length).toBe(rowCount + 4);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    });

    it(`keeps status and message of a task on the same line at ${width}`, () => {
      const lines = frameFor(width, 3, 3);
      const messageLines = lines.filter((l) => l.includes("task number 2"));
      expect(messageLines).toHaveLength(1);
      expect(messageLines[0]).toContain("pending");
    });

    it(`keeps the filter bar and the column header intact at ${width}`, () => {
      const lines = frameFor(width, 6, 6);
      expect(lines[0]).toContain("filter: all");
      expect(lines[1]).toContain("status");
      expect(lines[1]).toContain("schedule");
    });

    it(`spells the action keys in the footer at ${width}`, () => {
      const lines = frameFor(width, 3, 3);
      const hints = lines[lines.length - 1] ?? "";
      expect(hints).toContain("Enter detail");
      expect(hints).toContain("n new");
      expect(hints).toContain("c cancel");
    });
  }
});
