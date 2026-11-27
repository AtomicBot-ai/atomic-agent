import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { createWeakAnswerWatch, weakAnswerReason } from "./local-first-weak-answer.js";

function executed(tool: string, status: "ok" | "error", details: Record<string, unknown> = {}): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status, summary: "", details, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  } as AgentLoopEvent;
}

const empty = { type: "empty_completion_recovered", stepIndex: 1, attempt: 1, budget: 2 } as AgentLoopEvent;

describe("weak local answer watch (ATO-2434)", () => {
  it("an empty, cut or looping completion is weak at once", () => {
    expect(createWeakAnswerWatch().observe(empty)).toBe("empty");
    const cut = { type: "completion_truncated", stepIndex: 1 } as AgentLoopEvent;
    expect(createWeakAnswerWatch().observe(cut)).toBe("truncated");
    const looping = { type: "completion_truncated", stepIndex: 1, repetitive: true } as AgentLoopEvent;
    expect(createWeakAnswerWatch().observe(looping)).toBe("loop");
    const critical = { type: "loop_detected", tool: "fs.read", count: 5, stepIndex: 4, level: "critical" } as AgentLoopEvent;
    expect(createWeakAnswerWatch().observe(critical)).toBe("loop");
  });

  it("an early loop warning is not weak yet", () => {
    const warn = { type: "loop_detected", tool: "fs.read", count: 3, stepIndex: 2, level: "warn" } as AgentLoopEvent;
    expect(createWeakAnswerWatch().observe(warn)).toBeNull();
  });

  it("a failed check is weak only the second time", () => {
    const watch = createWeakAnswerWatch();
    expect(watch.observe(executed("verify.run", "error"))).toBeNull();
    expect(watch.observe(executed("verify.run", "ok"))).toBeNull();
    expect(watch.observe(executed("verify.run", "error"))).toBe("verify-failed");
  });

  it("two refused or unparseable tool calls are weak", () => {
    const watch = createWeakAnswerWatch();
    expect(watch.observe(executed("os.shell.run", "error", { deniedReason: "user declined" }))).toBeNull();
    expect(watch.observe(executed("fs.write", "error"))).toBeNull();
    const parse = { type: "parse_failure_recovered", stepIndex: 3, attempt: 1, budget: 3, reason: "bad json" } as AgentLoopEvent;
    expect(watch.observe(parse)).toBe("tool-refusals");
  });

  it("reports the first sign only", () => {
    const watch = createWeakAnswerWatch();
    expect(watch.observe(empty)).toBe("empty");
    expect(watch.observe(empty)).toBeNull();
  });

  it("words every sign in plain English", () => {
    for (const s of ["empty", "truncated", "loop", "verify-failed", "tool-refusals"] as const) {
      expect(weakAnswerReason(s)).toMatch(/^the local model/);
    }
  });
});
