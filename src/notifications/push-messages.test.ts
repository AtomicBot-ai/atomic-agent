import { describe, expect, it, vi } from "vitest";

import type { PushNotifyConfig } from "../config/index.js";
import type { TaskReport } from "../tasks/index.js";
import {
  formatApprovalPush,
  formatDownloadPush,
  formatTaskPush,
  formatTurnPush,
} from "./push-messages.js";
import { createPushTaskReportSink } from "./push-task-report.js";

describe("formatTurnPush", () => {
  it("leads with the outcome and carries the answer, not the step log", () => {
    const done = formatTurnPush({
      outcome: "completed",
      reply: "The build is green and the PR is open.",
      reason: "reply",
      stepCount: 12,
      durationMs: 95_000,
    });
    expect(done.title).toBe("Atomic Agent: turn done");
    expect(done.body).toBe("The build is green and the PR is open.");
  });

  it("falls back to steps and time when the turn left no answer", () => {
    const done = formatTurnPush({
      outcome: "completed",
      reply: null,
      reason: "finish",
      stepCount: 1,
      durationMs: 61_000,
      workingDirName: "app",
    });
    expect(done.body).toBe("1 step · 1m01s · app");
  });

  it("says why a turn failed, louder than a finish", () => {
    const failed = formatTurnPush({
      outcome: "failed",
      reply: "ignored",
      reason: "provider unreachable",
      stepCount: 3,
      durationMs: 4_000,
    });
    expect(failed.title).toBe("Atomic Agent: turn failed");
    expect(failed.body).toBe("provider unreachable · 3 steps · 4s");
    expect(failed.priority).toBe(4);
  });
});

describe("formatApprovalPush", () => {
  it("names the tool only, never the preview", () => {
    const note = formatApprovalPush("os.shell.run");
    expect(note.title).toMatch(/needs your approval/);
    expect(note.body).toBe("Waiting on os.shell.run. Open Atomic Agent to answer.");
  });
});

describe("formatTaskPush", () => {
  it("titles the job and carries its result", () => {
    const note = formatTaskPush({
      status: "completed",
      userMessage: "write the release notes",
      replyText: "Release notes are in NOTES.md.",
      errorMessage: null,
      durationMs: 3_600_000,
    });
    expect(note.title).toBe("Task done (60m00s): write the release notes");
    expect(note.body).toBe("Release notes are in NOTES.md.");
  });

  it("says a blocked task stopped and why", () => {
    const note = formatTaskPush({
      status: "blocked",
      userMessage: "overnight",
      replyText: null,
      errorMessage: "budget_spent: $5.00",
      durationMs: null,
    });
    expect(note.title).toBe("Task stopped: overnight");
    expect(note.body).toBe("budget_spent: $5.00");
  });
});

describe("formatDownloadPush", () => {
  it("splits the shared download text into title and body", () => {
    expect(formatDownloadPush("✅ Model ready: Qwen\n4.1 GB downloaded")).toEqual({
      title: "✅ Model ready: Qwen",
      body: "4.1 GB downloaded",
    });
  });
});

describe("createPushTaskReportSink", () => {
  const push: PushNotifyConfig = {
    enabled: true,
    server: "https://ntfy.example.com",
    topic: "atag-t",
    tokenEnv: "NTFY_TOKEN",
  };
  const report: TaskReport = {
    taskId: "task-1",
    notify: "push",
    status: "completed",
    userMessage: "scan files",
    scheduleKind: null,
    attempts: 1,
    maxAttempts: 1,
    durationMs: 1_000,
    replyText: "42 files scanned",
    errorMessage: null,
    errorCategory: null,
  };

  it("sends one ping per report", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await createPushTaskReportSink({ readPush: () => push, fetchImpl, env: {} })(report);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ topic: "atag-t", message: "42 files scanned" });
  });

  it("warns, and does not throw, when push is off", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await createPushTaskReportSink({
      readPush: () => ({ ...push, enabled: false }),
      logger: { warn },
      fetchImpl,
    })(report);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "task push report not sent",
      expect.objectContaining({ taskId: "task-1", outcome: "not_configured" }),
    );
  });
});
