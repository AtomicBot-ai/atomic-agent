import { describe, expect, it } from "vitest";

import type { TaskReport, TaskRunSummary } from "../../tasks/index.js";

import {
  formatTaskReportDigest,
  splitTaskReportDigest,
  TASK_REPORT_DIGEST_MAX_REPORTS,
  formatTaskReportMessage,
  TASK_REPORT_TRUNCATION_MARKER,
} from "./task-report-message.js";

function makeReport(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    taskId: "t-abc",
    status: "completed",
    userMessage: "morning digest",
    scheduleKind: "cron",
    attempts: 1,
    maxAttempts: 3,
    durationMs: 42_000,
    replyText: "3 new issues, all triaged.",
    errorMessage: null,
    errorCategory: null,
    ...overrides,
  };
}

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

describe("formatTaskReportMessage sections (ATO-964)", () => {
  it("renders Done, Failed and Needs you with the run facts in the meta line", () => {
    const text = formatTaskReportMessage(
      makeReport({
        replyText: "Fixed the parser.",
        stepCount: 37,
        stopCause: "step_ceiling",
        spendUsd: 0.4213,
        summary: summary({
          files: [{ path: "/w/parser.ts", kind: "edited", added: 12, removed: 3, approximate: false, writes: 2 }],
          commands: [
            { command: "npm test", exitCode: 0, timedOut: false, test: true, runs: 1 },
            { command: "npm run lint", exitCode: 1, timedOut: false, test: false, runs: 1 },
          ],
          approvals: [{ tool: "os.git.push", byUser: false }],
          questions: ["Merge it?"],
        }),
      }),
    );
    expect(text).toContain("Attempt 1/3 · took 42s · 37 steps · stop: step_ceiling · spend ~$0.42");
    expect(text).toContain("In words:\nFixed the parser.");
    const done = text.indexOf("Done:");
    const failed = text.indexOf("Failed:");
    const needs = text.indexOf("Needs you:");
    expect(done).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(done);
    expect(needs).toBeGreaterThan(failed);
    expect(text).toContain("- edited /w/parser.ts +12 -3");
    expect(text).toContain("- $ npm test : tests passed");
    expect(text).toContain("- $ npm run lint : exit 1");
    expect(text).toContain("- os.git.push needed an approval nobody gave.");
    expect(text).toContain("- Stopped at the step limit.");
    expect(text).toContain("- Asked: Merge it?");
  });

  it("omits the spend segment when spend is unknown and marks empty sections", () => {
    const text = formatTaskReportMessage(
      makeReport({ stepCount: 2, summary: summary() }),
    );
    expect(text).not.toContain("spend");
    expect(text).toContain("Done:\n  (none)");
    expect(text).toContain("Needs you:\n  (none)");
  });

  it("puts the task's own error first under Failed when run facts exist", () => {
    const text = formatTaskReportMessage(
      makeReport({
        status: "failed",
        replyText: null,
        errorMessage: "loop reported failed",
        errorCategory: "transport",
        summary: summary({ errors: ["turn failed [transport]: boom"] }),
      }),
    );
    expect(text).toContain("Failed:\n- Error [transport]: loop reported failed\n- turn failed [transport]: boom");
    expect(text).not.toContain("In words:");
  });

  it("stays inside one chunk with many entries and says what it cut", () => {
    const many = Array.from({ length: 60 }, (_, i) => `/w/${"d".repeat(150)}/file-${i}.ts`);
    const text = formatTaskReportMessage(
      makeReport({
        replyText: "r".repeat(20_000),
        summary: summary({
          files: many.map((path) => ({ path, kind: "edited" as const, added: 1, removed: 1, approximate: false, writes: 1 })),
          errors: many.map((p) => `os.fs.read: ${p}`),
          openItems: many,
        }),
      }),
    );
    expect(text.length).toBeLessThan(4000);
    expect(text).toMatch(/more not shown/);
    expect(text).toContain(TASK_REPORT_TRUNCATION_MARKER);
    // Every section header survives the shrinking.
    expect(text).toContain("Done:");
    expect(text).toContain("Failed:");
    expect(text).toContain("Needs you:");
  });
});

describe("formatTaskReportDigest", () => {
  it("renders a single held report as the ordinary report", () => {
    const r = makeReport();
    expect(formatTaskReportDigest([r])).toBe(formatTaskReportMessage(r));
  });

  it("merges several reports under one header with status counts", () => {
    const text = formatTaskReportDigest([
      makeReport({ taskId: "t-1" }),
      makeReport({ taskId: "t-2", status: "failed", replyText: null, errorMessage: "x", errorCategory: "tool" }),
      makeReport({ taskId: "t-3", status: "blocked", replyText: null, errorMessage: "y", errorCategory: "tool" }),
    ]);
    expect(text).toContain("Morning report: 3 tasks finished during quiet hours");
    expect(text).toContain("✅ 1 completed · ❌ 1 failed · ⛔ 1 blocked");
    for (const id of ["t-1", "t-2", "t-3"]) expect(text).toContain(id);
    expect(text.length).toBeLessThan(4000);
  });

  it("names the reports that do not fit instead of dropping them", () => {
    const reports = Array.from({ length: 30 }, (_, i) =>
      makeReport({ taskId: `t-${i}`, replyText: "r".repeat(5000) }),
    );
    const text = formatTaskReportDigest(reports);
    expect(text.length).toBeLessThan(4000);
    expect(text).toMatch(/more reports not shown: t-\d+/);
  });

  it("splits a long night into parts that show every report", () => {
    const reports = Array.from({ length: 18 }, (_, i) =>
      makeReport({ taskId: `t-0b8f6c2e-41d7-4a55-9a3e-5f1c7d2e9a${String(i).padStart(2, "0")}`, replyText: "r".repeat(5000) }),
    );
    const groups = splitTaskReportDigest(reports);
    expect(groups.flat()).toEqual(reports);
    expect(groups.every((g) => g.length >= 2 && g.length <= TASK_REPORT_DIGEST_MAX_REPORTS)).toBe(true);
    groups.forEach((group, i) => {
      const text = formatTaskReportDigest(group, { index: i + 1, total: groups.length });
      expect(text.length).toBeLessThan(4000);
      expect(text).not.toMatch(/more reports not shown/);
      expect(text).toContain(`Morning report (${i + 1}/${groups.length})`);
      for (const r of group) expect(text).toContain(r.taskId);
    });
  });
});
