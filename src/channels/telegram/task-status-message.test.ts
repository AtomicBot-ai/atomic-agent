import { describe, expect, it } from "vitest";

import type { TaskLiveStatus, TaskRunSummary } from "../../tasks/index.js";

import { formatTaskLiveStatus } from "./task-status-message.js";

function summary(overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    replyText: null,
    files: [],
    filesOmitted: 0,
    commands: [],
    commandsOmitted: 0,
    errors: [],
    errorsOmitted: 0,
    approvals: [],
    openItems: [],
    questions: [],
    creditExhausted: false,
    steps: 0,
    lastStep: null,
    ...overrides,
  };
}

function live(overrides: Partial<TaskLiveStatus> = {}): TaskLiveStatus {
  return {
    taskId: "t-1",
    userMessage: "fix the flaky test",
    startedAt: 0,
    summary: summary(),
    ...overrides,
  };
}

describe("formatTaskLiveStatus", () => {
  it("says so when nothing is running", () => {
    expect(formatTaskLiveStatus([], 0, 3000)).toBe("Running tasks: none.");
  });

  it("shows elapsed time, steps, the last step and the same sections as the report", () => {
    const text = formatTaskLiveStatus(
      [
        live({
          summary: summary({
            steps: 12,
            lastStep: "ran npm test",
            files: [{ path: "/w/a.ts", kind: "edited", added: 2, removed: 1, approximate: false, writes: 1 }],
            commands: [{ command: "npm test", exitCode: 1, timedOut: false, test: true, runs: 1 }],
          }),
        }),
      ],
      125_000,
      3000,
    );
    expect(text).toContain("Running tasks: 1");
    expect(text).toContain("▶ fix the flaky test (t-1)");
    expect(text).toContain("2m 5s so far · 12 steps");
    expect(text).toContain("Last step: ran npm test");
    expect(text).toContain("- edited /w/a.ts +2 -1");
    expect(text).toContain("- $ npm test : tests failed, exit 1");
  });

  it("stays near its budget with many running tasks", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      live({
        taskId: `t-${i}`,
        summary: summary({ replyText: "r".repeat(5000), errors: Array.from({ length: 30 }, () => "e".repeat(300)) }),
      }),
    );
    const text = formatTaskLiveStatus(many, 1000, 3000);
    expect(text.length).toBeLessThanOrEqual(3000);
  });
});
