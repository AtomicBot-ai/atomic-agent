import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import {
  WORKER_HINT_CONTEXT,
  WORKER_HINT_QUOTA,
  WORKER_HINT_SATURATED,
  WorkerRunCollector,
  classifyWorkerStatus,
  formatDelegateOutput,
  resultCarriesApprovalRefusal,
  workerFailureHint,
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

  it("puts the error on the head line and the hint and notes above the reply", () => {
    const out = formatDelegateOutput(
      [
        row({
          status: "max_steps",
          reply: "z".repeat(5000),
          error: "boom",
          hint: "do less",
          notes: ["stopped at its step limit"],
        }),
      ],
      600,
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      "[t1] max_steps — Map (2 steps, 3s, 1 tool calls, 0 errors) — error: boom",
    );
    // Above the body, so clipping a verbose reply can never hide them.
    expect(lines[1]).toBe("hint: do less");
    expect(lines[2]).toBe("note: stopped at its step limit");
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThanOrEqual(600);
  });

  it("flattens and bounds a long error on the head line", () => {
    const out = formatDelegateOutput(
      [row({ status: "failed", error: `line one\n  line two ${"e".repeat(2000)}` })],
      8000,
    );
    const head = out.split("\n")[0]!;
    expect(head).toContain("error: line one line two e");
    expect(head.length).toBeLessThan(600);
  });
});

describe("classifyWorkerStatus — a ceiling that ended the task", () => {
  it("reports max_steps for a reply written on the forced final step", () => {
    // A worker at 40/40 replied "the step limit was reached before the
    // file write could be executed" and came back `ok`.
    expect(classifyWorkerStatus("reply", false, "step_ceiling")).toBe(
      "max_steps",
    );
    expect(classifyWorkerStatus("finish", false, "time_ceiling")).toBe(
      "max_steps",
    );
    expect(classifyWorkerStatus("reply", false, undefined)).toBe("ok");
  });

  it("keeps the more urgent statuses ahead of it", () => {
    expect(classifyWorkerStatus("reply", true, "step_ceiling")).toBe(
      "needs_orchestrator",
    );
    expect(classifyWorkerStatus("failed", false, "step_ceiling")).toBe(
      "failed",
    );
    expect(classifyWorkerStatus("cancelled", false, "time_ceiling")).toBe(
      "cancelled",
    );
  });
});

describe("WorkerRunCollector — why a worker stopped", () => {
  const base = { id: "t", title: "T", stepCount: 0, durationMs: 590_000 };
  const waiting = (reason: string): AgentLoopEvent => ({
    type: "provider_waiting",
    attempt: 3,
    waitedMs: 580_000,
    maxWaitMs: 600_000,
    nextRetryMs: 10_000,
    reason,
  });

  it("carries the loop's last error and a remediation hint onto a failed row", () => {
    // The orchestrator used to read only "(the worker produced no reply)".
    const c = new WorkerRunCollector();
    c.observe({
      type: "loop_failed",
      error: new Error(
        'llama-server HTTP 500: {"error":{"code":500,"message":"Context size has been exceeded."}}',
      ),
      category: "transport",
    });
    const result = c.finish({ ...base, reason: "failed" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Context size has been exceeded");
    expect(result.hint).toBe(WORKER_HINT_CONTEXT);
    const out = formatDelegateOutput([result], 4000);
    expect(out).toContain(
      "[t] failed — T (0 steps, 590s, 0 tool calls, 0 errors) — error: llama-server HTTP 500:",
    );
    expect(out).toContain(`hint: ${WORKER_HINT_CONTEXT}`);
  });

  it("prefers the caller's error, and never reports a cancellation's abort as a cause", () => {
    const cancelled = new WorkerRunCollector();
    cancelled.observe({
      type: "loop_failed",
      error: new Error("This operation was aborted"),
      category: "cancelled",
    });
    expect(cancelled.finish({ ...base, reason: "cancelled" })).not.toHaveProperty(
      "error",
    );
    const both = new WorkerRunCollector();
    both.observe({
      type: "loop_failed",
      error: new Error("the loop's words"),
      category: "model",
    });
    expect(
      both.finish({ ...base, reason: "failed", error: "the caller's words" })
        .error,
    ).toBe("the caller's words");
  });

  it("falls back to the provider-wait reason when the turn never reached loop_failed", () => {
    const c = new WorkerRunCollector();
    c.observe(
      waiting(
        "llama-server accepted the request but sent no first token within 120000ms",
      ),
    );
    const result = c.finish({
      ...base,
      reason: "max_steps",
      stopCause: "time_ceiling",
    });
    expect(result.status).toBe("max_steps");
    expect(result.error).toBe(
      "the provider stopped answering: llama-server accepted the request but sent no first token within 120000ms",
    );
    expect(result.hint).toBe(WORKER_HINT_SATURATED);
    expect(result.notes?.[0]).toMatch(/time limit/);
  });

  it("forgets a wait the provider recovered from, and never puts an error on an ok row", () => {
    const recovered = new WorkerRunCollector();
    recovered.observe(waiting("fetch failed"));
    recovered.observe({ type: "provider_recovered", waitedMs: 5 });
    expect(
      recovered.finish({ ...base, reason: "max_steps" }),
    ).not.toHaveProperty("error");
    const ok = new WorkerRunCollector();
    ok.observe(waiting("fetch failed"));
    const row = ok.finish({ ...base, reason: "reply" });
    expect(row.status).toBe("ok");
    expect(row).not.toHaveProperty("error");
    expect(row).not.toHaveProperty("hint");
  });

  it("notes that a reply on the forced final step may describe undone work", () => {
    const c = new WorkerRunCollector();
    c.observe(
      reply(
        "the step limit was reached before the file write could be executed",
      ),
    );
    const result = c.finish({
      ...base,
      stepCount: 40,
      reason: "reply",
      stopCause: "step_ceiling",
    });
    expect(result.status).toBe("max_steps");
    expect(result.notes).toHaveLength(1);
    expect(result.notes![0]).toMatch(/step limit \(40 steps\)/);
    expect(result).not.toHaveProperty("error");
  });
});

describe("workerFailureHint", () => {
  it.each([
    ["Context size has been exceeded.", WORKER_HINT_CONTEXT],
    [
      "the request exceeds the available context size, try increasing it",
      WORKER_HINT_CONTEXT,
    ],
    [
      "model response truncated at step 3: the model server ran out of context before the reply finished",
      WORKER_HINT_CONTEXT,
    ],
    [
      // Mentions "prompt/context", but it is the deadline, not the window.
      "llama-server accepted the request but sent no first token within 120000ms — it may still be evaluating the prompt; raise localModels.requestTimeoutMs, or shorten the prompt/context if it is too large for this machine to evaluate in time",
      WORKER_HINT_SATURATED,
    ],
    [
      "llama-server sent no data for 120000ms mid-stream — the server stopped responding",
      WORKER_HINT_SATURATED,
    ],
    ["openrouter HTTP 402: Payment Required", WORKER_HINT_QUOTA],
    ["HTTP 429: Too Many Requests", WORKER_HINT_QUOTA],
    ["insufficient credits on this API key", WORKER_HINT_QUOTA],
  ])("recognises %s", (message, hint) => {
    expect(workerFailureHint(message)).toBe(hint);
  });

  it("stays silent on failures it has no remedy for", () => {
    expect(workerFailureHint("provider exploded")).toBeUndefined();
    expect(workerFailureHint("ENOENT: no such file")).toBeUndefined();
    expect(workerFailureHint("waited 4290ms")).toBeUndefined();
  });
});
