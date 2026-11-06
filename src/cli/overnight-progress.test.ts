import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/index.js";
import type { TaskRecord } from "../tasks/index.js";
import {
  formatElapsed,
  formatOvernightSummary,
  formatProgressLine,
  overnightExitCode,
  replyFromEvent,
} from "./overnight-progress.js";

describe("overnight progress", () => {
  it("prints one compact line per step, with spend against the cap", () => {
    expect(
      formatProgressLine({
        stepIndex: 11,
        summary: "read\n  src/app.ts",
        elapsedMs: 14 * 60_000,
        spendUsd: 0.42,
        capUsd: 5,
      }),
    ).toBe("[step 12 | 14m | $0.42 of $5.00] read src/app.ts");
    expect(
      formatProgressLine({ stepIndex: 0, summary: "x", elapsedMs: 0, spendUsd: undefined, capUsd: 0 }),
    ).toBe("[step 1 | 0m] x");
    const long = formatProgressLine({
      stepIndex: 0,
      summary: "a".repeat(300),
      elapsedMs: 0,
      spendUsd: 0.001,
      capUsd: 0,
    });
    expect(long).toMatch(/^\[step 1 \| 0m \| \$0\.0010\] a+\.\.\.$/);
    expect(long.length).toBeLessThan(140);
  });

  it("adds what the task spent before this run to the spend shown", () => {
    expect(
      formatProgressLine({
        stepIndex: 0,
        summary: "resume",
        elapsedMs: 0,
        spendUsd: 0.5,
        spentBeforeUsd: 3,
        capUsd: 5,
      }),
    ).toBe("[step 1 | 0m | $3.50 of $5.00] resume");
    expect(
      formatProgressLine({
        stepIndex: 0,
        summary: "x",
        elapsedMs: 0,
        spendUsd: undefined,
        spentBeforeUsd: 1,
        capUsd: 0,
      }),
    ).toBe("[step 1 | 0m | $1.00] x");
  });

  it("says an interrupted run stays queued", () => {
    const text = formatOvernightSummary({
      task: { id: "t-2", status: "pending", spentUsd: 0.3, lastError: null } as unknown as TaskRecord,
      elapsedMs: 0,
      capUsd: 0,
      reply: null,
      deniedApprovals: 0,
    });
    expect(text).toContain("overnight pending: t-2");
    expect(text).toContain("stays queued to resume");
  });

  it("formats elapsed time in minutes and hours", () => {
    expect(formatElapsed(59_999)).toBe("0m");
    expect(formatElapsed(60 * 60_000)).toBe("1h");
    expect(formatElapsed(95 * 60_000)).toBe("1h35m");
  });

  it("picks the result out of the event stream, skipping progress notes", () => {
    const reply = (text: string, progressNote?: true): AgentLoopEvent =>
      ({
        type: "llm_event",
        event: { type: "assistant_reply", text, ...(progressNote ? { progressNote } : {}) },
      }) as unknown as AgentLoopEvent;
    expect(replyFromEvent(reply("done"))).toBe("done");
    expect(replyFromEvent(reply("halfway", true))).toBeUndefined();
    const finish = {
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result: { tool: "finish", status: "ok", summary: "short", details: { summary: "full story" } },
      },
    } as unknown as AgentLoopEvent;
    expect(replyFromEvent(finish)).toBe("full story");
    expect(replyFromEvent({ type: "step_started", stepIndex: 0 })).toBeUndefined();
  });

  it("closes with status, time, spend, denials and the reply", () => {
    const task = {
      id: "t-1",
      status: "completed",
      spentUsd: 1.2,
      lastError: null,
    } as unknown as TaskRecord;
    const text = formatOvernightSummary({
      task,
      elapsedMs: 125 * 60_000,
      capUsd: 5,
      reply: "All tests pass.",
      deniedApprovals: 2,
    });
    expect(text).toContain("overnight completed: t-1");
    expect(text).toContain("time:  2h5m");
    expect(text).toContain("spent: $1.20 of $5.00");
    expect(text).toContain("denied 2 action(s)");
    expect(text.trimEnd().endsWith("All tests pass.")).toBe(true);

    const failed = formatOvernightSummary({
      task: { ...task, status: "failed", spentUsd: null, lastError: "model down" } as TaskRecord,
      elapsedMs: 0,
      capUsd: 0,
      reply: null,
      deniedApprovals: 0,
    });
    expect(failed).toContain("spent: $0.00 (estimate");
    expect(failed).toContain("error: model down");
    expect(failed).not.toContain("denied");
  });

  it("exits 0 only on completed", () => {
    expect(overnightExitCode("completed")).toBe(0);
    expect(overnightExitCode("failed")).toBe(1);
    expect(overnightExitCode("cancelled")).toBe(1);
  });
});
