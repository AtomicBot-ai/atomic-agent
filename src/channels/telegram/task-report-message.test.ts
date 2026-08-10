import { describe, expect, it } from "vitest";

import type { TaskReport } from "../../tasks/index.js";

import {
  formatTaskReportMessage,
  TASK_REPORT_ERROR_MAX_CHARS,
  TASK_REPORT_PROMPT_PREVIEW_CHARS,
  TASK_REPORT_RESULT_MAX_CHARS,
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

describe("formatTaskReportMessage", () => {
  it("renders a completed report with prompt, schedule label, meta, and reply", () => {
    const text = formatTaskReportMessage(makeReport());
    expect(text).toContain("✅ Scheduled task completed");
    expect(text).toContain("Task: morning digest (cron t-abc)");
    expect(text).toContain("Attempt 1/3 · took 42s");
    expect(text).toContain("3 new issues, all triaged.");
  });

  it("renders '(no reply)' when a completed turn produced no reply text", () => {
    const text = formatTaskReportMessage(makeReport({ replyText: null }));
    expect(text).toContain("(no reply)");
  });

  it("truncates a long reply with an explicit marker", () => {
    const long = "x".repeat(TASK_REPORT_RESULT_MAX_CHARS + 500);
    const text = formatTaskReportMessage(makeReport({ replyText: long }));
    expect(text).toContain(TASK_REPORT_TRUNCATION_MARKER);
    expect(text.length).toBeLessThan(long.length);
  });

  it("keeps a reply at the cap untouched (no marker)", () => {
    const exact = "y".repeat(TASK_REPORT_RESULT_MAX_CHARS);
    const text = formatTaskReportMessage(makeReport({ replyText: exact }));
    expect(text).not.toContain(TASK_REPORT_TRUNCATION_MARKER);
    expect(text).toContain(exact);
  });

  it("renders a failed report with the error category and message", () => {
    const text = formatTaskReportMessage(
      makeReport({
        status: "failed",
        attempts: 3,
        replyText: null,
        errorMessage: "llama-server unreachable",
        errorCategory: "transport",
      }),
    );
    expect(text).toContain("❌ Scheduled task failed");
    expect(text).toContain("Error [transport]: llama-server unreachable");
    expect(text).toContain("Attempt 3/3");
  });

  it("renders a blocked report and truncates a long error", () => {
    const longError = "e".repeat(TASK_REPORT_ERROR_MAX_CHARS + 100);
    const text = formatTaskReportMessage(
      makeReport({
        status: "blocked",
        replyText: null,
        errorMessage: longError,
        errorCategory: "tool",
      }),
    );
    expect(text).toContain("⛔ Scheduled task blocked");
    expect(text).toContain(TASK_REPORT_TRUNCATION_MARKER);
  });

  it("falls back honestly when a failed report carries no error details", () => {
    const text = formatTaskReportMessage(
      makeReport({
        status: "failed",
        replyText: null,
        errorMessage: null,
        errorCategory: null,
      }),
    );
    expect(text).toContain("Error [unknown]: (no error recorded)");
  });

  it("collapses whitespace and caps the prompt preview", () => {
    const noisy = `line one\n\tline${" ".repeat(10)}two ${"p".repeat(300)}`;
    const text = formatTaskReportMessage(makeReport({ userMessage: noisy }));
    const taskLine = text.split("\n")[1]!;
    expect(taskLine).toContain("line one line two");
    expect(taskLine).not.toContain("\t");
    // preview cap + "…" + surrounding label text, never the raw 300 chars
    expect(taskLine.length).toBeLessThan(
      TASK_REPORT_PROMPT_PREVIEW_CHARS + 60,
    );
  });

  it("labels one-shot tasks (at-schedule and eager) as one-shot", () => {
    const atText = formatTaskReportMessage(makeReport({ scheduleKind: "at" }));
    const eagerText = formatTaskReportMessage(
      makeReport({ scheduleKind: null }),
    );
    expect(atText).toContain("(one-shot t-abc)");
    expect(eagerText).toContain("(one-shot t-abc)");
  });

  it("omits the duration segment when durationMs is unknown", () => {
    const text = formatTaskReportMessage(makeReport({ durationMs: null }));
    expect(text).toContain("Attempt 1/3");
    expect(text).not.toContain("took");
  });

  it("never splits a surrogate pair when truncating the reply", () => {
    // "a" + 1500 emoji (2 UTF-16 units each) = 3001 units; the 3000-unit
    // cut lands in the middle of the last pair. A naive slice would leave
    // a lone high surrogate at the cut.
    const reply = `a${"💚".repeat(1500)}`;
    expect(reply.length).toBe(TASK_REPORT_RESULT_MAX_CHARS + 1);
    const text = formatTaskReportMessage(makeReport({ replyText: reply }));
    expect(text).toContain(TASK_REPORT_TRUNCATION_MARKER);
    expect(hasLoneSurrogate(text)).toBe(false);
  });

  it("never splits a surrogate pair when truncating the error", () => {
    const error = `x${"🐛".repeat(TASK_REPORT_ERROR_MAX_CHARS)}`;
    const text = formatTaskReportMessage(
      makeReport({
        status: "failed",
        replyText: null,
        errorMessage: error,
        errorCategory: "transport",
      }),
    );
    expect(text).toContain(TASK_REPORT_TRUNCATION_MARKER);
    expect(hasLoneSurrogate(text)).toBe(false);
  });

  it("never splits a surrogate pair in the prompt preview", () => {
    // 118 chars of prefix put the first emoji pair on UTF-16 units
    // 118-119, so the preview cut (cap - 1 = 119) lands mid-pair. A
    // naive slice would keep the lone high surrogate.
    const prompt = `${"p".repeat(TASK_REPORT_PROMPT_PREVIEW_CHARS - 2)}😀😀😀`;
    const text = formatTaskReportMessage(makeReport({ userMessage: prompt }));
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toContain("…");
  });
});

/** True when `text` contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    text,
  );
}
