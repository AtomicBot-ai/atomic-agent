import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-197: a tool call's outcome over SSE, the moment it lands.
 *
 * The stream said a call started (`tool_progress`) and nothing more, so a
 * host drew every call as running until the turn was over and the session
 * store described it: a write that finished in a second, a command that
 * failed, a call the operator denied all spun for as long as the turn ran,
 * and after a Stop for good. `tool_result` answers each `tool_progress`,
 * matched by `call_id`.
 */
describe("tool_result over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "s-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;
  const result = (over: Partial<CompressedToolResult> = {}): CompressedToolResult => ({
    tool: "os.fs.write",
    status: "ok",
    summary: "wrote test2.txt (12 bytes)",
    details: {},
    truncated: false,
    ...over,
  });
  const parsed = (tool: string, batchIndex: number, batchSize = 1): AgentLoopEvent => ({
    type: "llm_event",
    event: { type: "tool_call_parsed", call: { tool, args: { path: "test2.txt" } }, batchIndex, batchSize },
  });
  const executed = (r: CompressedToolResult, batchIndex: number, durationMs?: number, batchSize = 1): AgentLoopEvent => ({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: r,
      batchIndex,
      batchSize,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  });
  const frames = (sse: ReturnType<typeof makeSse>, name: string) =>
    sse.written.filter((w) => w.name === name).map((w) => w.payload as Record<string, unknown>);

  it("answers a call's tool_progress with its outcome, under the same call_id", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({ type: "step_started", stepIndex: 3 });
    hook(parsed("os.fs.write", 0));
    hook(executed(result(), 0, 41.6));

    const progress = frames(sse, "tool_progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]!.call_id).toBe("3:0");
    expect(frames(sse, "tool_result")).toEqual([
      {
        id: "cmpl-1",
        object: "chat.completion.tool_result",
        created: 0,
        model: "atomic-agent",
        session_id: "s-1",
        call_id: "3:0",
        tool: "os.fs.write",
        status: "ok",
        duration_ms: 42,
        summary: "wrote test2.txt (12 bytes)",
      },
    ]);
  });

  it("keys each call of a batch by its place in it, whatever order the results land in", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({ type: "step_started", stepIndex: 1 });
    hook(parsed("os.fs.read", 0, 2));
    hook(parsed("os.shell.run", 1, 2));
    hook(executed(result({ tool: "os.shell.run", status: "error", summary: "$ fsutil x\nexit: 1" }), 1, 900, 2));
    hook(executed(result({ tool: "os.fs.read", summary: "read a.txt" }), 0, 5, 2));
    hook({ type: "step_started", stepIndex: 2 });
    hook(parsed("os.fs.read", 0));
    hook(executed(result({ tool: "os.fs.read" }), 0, 3));

    expect(frames(sse, "tool_progress").map((p) => p.call_id)).toEqual(["1:0", "1:1", "2:0"]);
    expect(frames(sse, "tool_result").map((p) => [p.call_id, p.tool, p.status])).toEqual([
      ["1:1", "os.shell.run", "error"],
      ["1:0", "os.fs.read", "ok"],
      ["2:0", "os.fs.read", "ok"],
    ]);
  });

  it("says a call the operator denied is denied, not failed", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const denied = "approval denied for os.shell.run";

    hook({ type: "step_started", stepIndex: 0 });
    // Thrown out of the tool and folded into a result by the batch executor.
    hook(executed(result({ tool: "os.shell.run", status: "error", summary: denied, details: { errorName: "ApprovalDeniedError" } }), 0, 8000));
    // A prompted approval answered no, whatever the tool made of it.
    hook(executed(result({ tool: "os.fs.read", status: "error", summary: "not read",
      approvals: [{ verdict: "denied", category: "fs_read_outside", at: 1 }] }), 1));
    // An MCP call stamps it itself.
    hook(executed(result({ tool: "mcp.github.create_issue", status: "error", summary: denied, details: { approvalDenied: true } }), 2));
    // The loop guard's refusal is the agent's own verdict: an error.
    hook(executed(result({ tool: "os.shell.run", status: "error", summary: "stop repeating", details: { deniedReason: "tool-loop" } }), 3));
    // An approval granted does not make a failure a denial.
    hook(executed(result({ tool: "os.shell.run", status: "error", summary: "exit: 2",
      approvals: [{ verdict: "approved", category: "shell", at: 1 }] }), 4));

    expect(frames(sse, "tool_result").map((p) => p.status)).toEqual(["denied", "denied", "denied", "error", "error"]);
  });

  it("says a call that never ran is cancelled", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({ type: "step_started", stepIndex: 0 });
    hook(executed(result({ status: "error", summary: "cancelled before invocation (batch index 1)", details: { cancelled: true } }), 1));

    expect(frames(sse, "tool_result")[0]).toMatchObject({ call_id: "0:1", status: "cancelled" });
  });

  it("leaves duration_ms out when nothing measured the call, and clips a long summary", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({ type: "step_started", stepIndex: 0 });
    hook(executed(result({ tool: "reply", summary: "x".repeat(5000) }), 0));

    const frame = frames(sse, "tool_result")[0]!;
    expect(frame).not.toHaveProperty("duration_ms");
    expect(String(frame.summary).length).toBe(400);
    expect(String(frame.summary).endsWith("…")).toBe(true);
  });

  it("sends nothing to an OpenAI-compatible client", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));

    hook({ type: "step_started", stepIndex: 0 });
    hook(parsed("os.fs.write", 0));
    hook(executed(result(), 0, 12));

    expect(sse.written).toEqual([]);
  });
});
