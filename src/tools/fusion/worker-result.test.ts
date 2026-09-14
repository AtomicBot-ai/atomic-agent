import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import {
  WORKER_HINT_CONTEXT,
  WORKER_HINT_QUOTA,
  WORKER_HINT_SATURATED,
  WorkerRunCollector,
  classifyWorkerStatus,
  delegateOutcome,
  fanoutSpend,
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
        writes: 0,
        byTool: { "os.fs.read": 2, "os.fs.grep": 1 },
      },
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
    });
  });

  it("counts only the write, edit and patch calls that succeeded", () => {
    const c = new WorkerRunCollector();
    c.observe(toolExecuted("os.fs.write", "ok"));
    c.observe(toolExecuted("os.fs.edit", "ok"));
    c.observe(toolExecuted("os.fs.patch", "error", "no such file"));
    // A refused write is not a write.
    c.observe(toolExecuted("os.fs.write", "error", `denied: ${FUSION_WORKER_APPROVAL_REFUSED}`));
    // A shell command may write, but the collector cannot know; the disk check does.
    c.observe(toolExecuted("os.shell.run", "ok"));
    const result = c.finish({ id: "t", title: "T", reason: "reply", stepCount: 5, durationMs: 1 });
    expect(result.tools).toMatchObject({ calls: 5, errors: 2, writes: 2 });
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
    expect(result.tools).toEqual({ calls: 0, errors: 0, writes: 0, byTool: {} });
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
    tools: { calls: 1, errors: 0, writes: 0, byTool: { "os.fs.read": 1 } },
    ...over,
  };
}

describe("delegateOutcome", () => {
  it("is all_ok only when every task is ok, all_failed only when every task failed or was cancelled", () => {
    expect(delegateOutcome([row(), row({ id: "t2" })])).toBe("all_ok");
    expect(delegateOutcome([row({ status: "failed" }), row({ id: "t2", status: "cancelled" })])).toBe("all_failed");
    expect(delegateOutcome([row({ status: "failed" }), row({ id: "t2" })])).toBe("partial");
    // A task that produced nothing usable is still not "failed": the
    // orchestrator gets its reply and re-delegates from it.
    for (const status of ["no_changes", "max_steps", "needs_orchestrator"] as const) {
      expect(delegateOutcome([row({ status })])).toBe("partial");
      expect(delegateOutcome([row({ status }), row({ id: "t2", status: "failed" })])).toBe("partial");
    }
  });
});

describe("fan-out spend in the status table header (F20)", () => {
  it("prices the tasks' usage and states it on the head line", () => {
    const results = [
      row({ usage: { promptTokens: 400_000, completionTokens: 100_000, totalTokens: 500_000 } }),
      row({ id: "t2", usage: { promptTokens: 100_000, completionTokens: 50_000, totalTokens: 150_000 } }),
      row({ id: "t3" }), // died before its first completion: no usage
    ];
    const spend = fanoutSpend(results, { input: 1, output: 4 }, "z-ai/glm-5.3-flash");
    expect(spend).toEqual({
      usd: 0.5 + 0.6,
      model: "z-ai/glm-5.3-flash",
      promptTokens: 500_000,
      completionTokens: 150_000,
    });
    const out = formatDelegateOutput(results, 4000, { spend });
    expect(out.split("\n")[0]).toBe(
      "3 tasks: 3 ok — cloud spend $1.10 on z-ai/glm-5.3-flash (500,000 in / 150,000 out)",
    );
    // Without pricing the head line is as it was.
    expect(formatDelegateOutput(results, 4000).split("\n")[0]).toBe("3 tasks: 3 ok");
  });
});

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
    // The task's block is the second paragraph, after the status table.
    const lines = out.split("\n\n")[1]!.split("\n");
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
    const head = out.split("\n\n")[1]!.split("\n")[0]!;
    expect(head).toContain("error: line one line two e");
    expect(head.length).toBeLessThan(600);
  });

  it("opens with one status line per task, so a clipped view still shows every outcome", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row({ id: `t${i + 1}`, reply: "w".repeat(3000) }),
    );
    rows[3] = row({ id: "t4", status: "max_steps", error: "step limit" });
    rows[6] = row({
      id: "t7",
      title: "Main",
      reply: "I'm done!",
      notes: ["js/main.js unchanged by this task"],
    });
    const out = formatDelegateOutput(rows, 16000);
    // A prompt that renders only the first part of the result still has
    // every task, and the note that one of them changed nothing.
    const view = out.slice(0, 1000);
    expect(view.startsWith("7 tasks: 6 ok, 1 max_steps")).toBe(true);
    for (let i = 1; i <= 7; i += 1) expect(view).toContain(`- [t${i}] `);
    expect(view).toContain("- [t4] max_steps — Map — error: step limit");
    expect(view).toContain(
      "- [t7] ok — Main — js/main.js unchanged by this task",
    );
    expect(out.length).toBeLessThanOrEqual(16000);
  });
});

describe("formatDelegateOutput — the contract", () => {
  it("puts the contract line right under the head line, and each task's checks on its row and block", () => {
    const out = formatDelegateOutput(
      [
        row({ checks: { total: 2, failed: 0 } }),
        row({
          id: "t2",
          status: "failed",
          error: "checks: no errors: 1 pageerror",
          checks: { total: 2, failed: 1, detail: "no errors: 1 pageerror" },
        }),
      ],
      8000,
      { contractLine: "contract: 1 missing — [t1] symbol HD.Ship not in js/ship.js" },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("2 tasks: 1 ok, 1 failed");
    expect(lines[1]).toBe("contract: 1 missing — [t1] symbol HD.Ship not in js/ship.js");
    expect(lines[2]).toBe("- [t1] ok — Map — checks: 2 of 2 passed");
    // The error already carries the verdict, so the count stands alone.
    expect(lines[3]).toBe(
      "- [t2] failed — Map — error: checks: no errors: 1 pageerror — checks: 1 of 2 failed",
    );
    const block = out.split("\n\n")[2]!.split("\n");
    expect(block[0]).toContain("[t2] failed — Map (2 steps, 3s, 1 tool calls, 0 errors) — error: checks: no errors: 1 pageerror");
    expect(block[1]).toBe("checks: 1 of 2 failed");
  });

  it("keeps the checks detail on a row whose error is something else", () => {
    const out = formatDelegateOutput(
      [
        row({
          status: "failed",
          error: "declared file a.js does not exist after the task",
          checks: { total: 1, failed: 1, detail: "exit code 1" },
        }),
      ],
      4000,
    );
    expect(out.split("\n")[1]).toBe(
      "- [t1] failed — Map — error: declared file a.js does not exist after the task — checks: 1 of 1 failed — exit code 1",
    );
  });

  it("renders no contract line when none was given", () => {
    expect(formatDelegateOutput([row()], 4000).split("\n")[1]).toBe("- [t1] ok — Map");
  });
});

describe("formatDelegateOutput — the head line", () => {
  it("counts every status, in a fixed order, whatever order the tasks finished in", () => {
    const rows = [
      row({ id: "t1", status: "failed", error: "boom" }),
      row({ id: "t2", status: "no_changes", notes: ["js/main.js unchanged by this task"] }),
      row({ id: "t3" }),
      row({ id: "t4", status: "cancelled" }),
      row({ id: "t5" }),
      row({ id: "t6", status: "max_steps" }),
      row({ id: "t7", status: "needs_orchestrator" }),
    ];
    const out = formatDelegateOutput(rows, 16000);
    expect(out.split("\n")[0]).toBe(
      "7 tasks: 2 ok, 1 no_changes, 1 needs_orchestrator, 1 max_steps, 1 failed, 1 cancelled",
    );
    expect(out).toContain("- [t2] no_changes — Map — js/main.js unchanged by this task");
    expect(out).toContain("[t2] no_changes — Map (2 steps, 3s, 1 tool calls, 0 errors)");
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
