import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import {
  WorkerRunCollector,
  classifyWorkerStatus,
  formatDelegateOutput,
  resultCarriesApprovalRefusal,
  type WorkerTaskResult,
} from "./worker-result.js";
import { FUSION_WORKER_APPROVAL_REFUSED } from "./worker-tool-policy.js";

function toolExecuted(
  tool: string,
  status: "ok" | "error",
  summary = "done",
  details: Record<string, unknown> = {},
): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status, summary, details, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  };
}

function reply(text: string): AgentLoopEvent {
  return { type: "llm_event", event: { type: "assistant_reply", text } };
}

function completed(
  usage:
    | { promptTokens: number; completionTokens: number; totalTokens: number }
    | undefined,
): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "llm_completed",
      completion: {
        content: "",
        reasoningContent: "",
        stop: true,
        truncated: false,
        timing: {
          promptMs: 1,
          predictedMs: 1,
          promptTokens: 1,
          predictedTokens: 1,
        },
        cacheHitTokens: 0,
        slotId: 0,
        modelId: "m",
        ...(usage ? { usage } : {}),
      },
    },
  };
}

describe("WorkerRunCollector", () => {
  it("collects the reply, the tool tally and the summed usage", () => {
    const c = new WorkerRunCollector();
    c.observe(toolExecuted("os.fs.read", "ok"));
    c.observe(toolExecuted("os.fs.read", "error"));
    c.observe(toolExecuted("os.fs.grep", "ok"));
    c.observe(
      completed({ promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
    );
    c.observe(
      completed({ promptTokens: 5, completionTokens: 3, totalTokens: 8 }),
    );
    c.observe(reply("here is the map"));
    const result = c.finish({
      id: "t1",
      title: "Map",
      reason: "reply",
      stepCount: 3,
      durationMs: 1200,
    });
    expect(result).toMatchObject({
      id: "t1",
      status: "ok",
      reply: "here is the map",
      stepCount: 3,
      tools: {
        calls: 3,
        errors: 1,
        byTool: { "os.fs.read": 2, "os.fs.grep": 1 },
      },
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
    });
  });

  it("keeps the last reply when an auto-continued turn emits several", () => {
    const c = new WorkerRunCollector();
    c.observe(reply("first leg"));
    c.observe(reply("final answer"));
    expect(
      c.finish({
        id: "t",
        title: "T",
        reason: "reply",
        stepCount: 1,
        durationMs: 1,
      }).reply,
    ).toBe("final answer");
  });

  it("omits usage entirely when no completion reported any", () => {
    const c = new WorkerRunCollector();
    c.observe(completed(undefined));
    expect(
      c.finish({
        id: "t",
        title: "T",
        reason: "reply",
        stepCount: 1,
        durationMs: 1,
      }),
    ).not.toHaveProperty("usage");
  });

  it("ignores events that are not llm_event", () => {
    const c = new WorkerRunCollector();
    c.observe({ type: "turn_started", turnIndex: 0 });
    c.observe({ type: "step_started", stepIndex: 0 });
    const result = c.finish({
      id: "t",
      title: "T",
      reason: "reply",
      stepCount: 0,
      durationMs: 0,
    });
    expect(result.tools).toEqual({ calls: 0, errors: 0, byTool: {} });
  });

  it("reports needs_orchestrator when a tool result carried the refusal", () => {
    // The worker did reply — but it replied by handing an action back,
    // and an orchestrator that read that as `ok` would merge a hole.
    const c = new WorkerRunCollector();
    c.observe(
      toolExecuted(
        "os.fs.write",
        "error",
        `denied: ${FUSION_WORKER_APPROVAL_REFUSED}`,
      ),
    );
    c.observe(reply("needs `npm run build` run for me"));
    expect(
      c.finish({
        id: "t",
        title: "T",
        reason: "reply",
        stepCount: 2,
        durationMs: 5,
      }).status,
    ).toBe("needs_orchestrator");
  });

  it("finds the refusal in details.deniedReason as well as the summary", () => {
    expect(
      resultCarriesApprovalRefusal("denied", {
        deniedReason: FUSION_WORKER_APPROVAL_REFUSED,
      }),
    ).toBe(true);
    expect(resultCarriesApprovalRefusal("all good", {})).toBe(false);
    expect(resultCarriesApprovalRefusal("all good", { deniedReason: 7 })).toBe(
      false,
    );
  });
});

describe("classifyWorkerStatus", () => {
  it("maps the loop reasons onto worker statuses", () => {
    expect(classifyWorkerStatus("reply", false)).toBe("ok");
    expect(classifyWorkerStatus("finish", false)).toBe("ok");
    expect(classifyWorkerStatus("max_steps", false)).toBe("max_steps");
    expect(classifyWorkerStatus("cancelled", false)).toBe("cancelled");
    expect(classifyWorkerStatus("failed", false)).toBe("failed");
    // A thrown turn has no reason at all.
    expect(classifyWorkerStatus(null, false)).toBe("failed");
  });

  it("lets a refusal outrank a finished turn but not a broken one", () => {
    expect(classifyWorkerStatus("reply", true)).toBe("needs_orchestrator");
    expect(classifyWorkerStatus("max_steps", true)).toBe("needs_orchestrator");
    // `failed` / `cancelled` say the reply is not even complete: that is
    // the more urgent fact and must not be masked.
    expect(classifyWorkerStatus("failed", true)).toBe("failed");
    expect(classifyWorkerStatus("cancelled", true)).toBe("cancelled");
  });
});

function row(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "Map",
    status: "ok",
    reply: "the map",
    stepCount: 2,
    durationMs: 3000,
    tools: { calls: 1, errors: 0, byTool: { "os.fs.read": 1 } },
    ...over,
  };
}

describe("formatDelegateOutput", () => {
  it("renders one headed block per task", () => {
    const out = formatDelegateOutput(
      [row(), row({ id: "t2", status: "failed" })],
      4000,
    );
    expect(out).toContain(
      "[t1] ok — Map (2 steps, 3s, 1 tool calls, 0 errors)",
    );
    expect(out).toContain("[t2] failed — Map");
    expect(out).toContain("the map");
  });

  it("names a worker that produced nothing rather than showing a blank", () => {
    expect(formatDelegateOutput([row({ reply: "" })], 4000)).toContain(
      "(the worker produced no reply)",
    );
  });

  it("caps each task so one verbose worker cannot crowd out its siblings", () => {
    const long = row({ reply: "x".repeat(5000) });
    const out = formatDelegateOutput(
      [long, row({ id: "t2", reply: "short" })],
      2000,
    );
    expect(out).toContain("[truncated]");
    // The sibling survives — the whole value of a fan-out is seeing the
    // parts, and a single greedy block must not eat the budget.
    expect(out).toContain("[t2]");
    expect(out).toContain("short");
  });

  it("caps the total as well as the per-task share", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ id: `t${i}`, reply: "y".repeat(3000) }),
    );
    expect(formatDelegateOutput(rows, 1000).length).toBeLessThanOrEqual(1000);
  });

  it("shows the error line when a task carried one", () => {
    expect(
      formatDelegateOutput([row({ status: "failed", error: "boom" })], 4000),
    ).toContain("error: boom");
  });

  it("says so when nothing ran", () => {
    expect(formatDelegateOutput([], 4000)).toBe("(no tasks were run)");
  });
});
