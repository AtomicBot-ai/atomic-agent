import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  AcpTurnTranslator,
  OPTION_ALLOW,
  OPTION_ALLOW_ALWAYS,
  OPTION_ALLOW_SESSION,
  OPTION_REJECT,
  permissionDecision,
  permissionOptions,
  permissionToolCall,
  planUpdate,
  promptToText,
  stopReason,
  toolKind,
  toolTitle,
} from "./acp-translator.js";

function llm(event: unknown): AgentLoopEvent {
  return { type: "llm_event", event } as unknown as AgentLoopEvent;
}

function result(tool: string, status: "ok" | "error", summary: string): CompressedToolResult {
  return { tool, status, summary, details: {}, truncated: false };
}

const shellRequest: ApprovalRequest = {
  approvalId: "ap-1",
  sessionId: "s-1",
  tool: "os.shell.run",
  category: "shell",
  reason: "run a command",
  preview: "npm test",
  commandShape: "npm",
  commandArgv: ["npm", "test"],
};

describe("promptToText (ATO-543)", () => {
  it("joins text, names links and inlines embedded text resources", () => {
    expect(
      promptToText([
        { type: "text", text: "Fix the bug in" },
        { type: "resource_link", uri: "file:///repo/a.ts", name: "a.ts" },
        { type: "resource", resource: { uri: "file:///repo/b.ts", text: "const b = 1;" } },
        { type: "image", data: "xxx", mimeType: "image/png" },
      ]),
    ).toBe(
      'Fix the bug in\n\n[@a.ts](file:///repo/a.ts)\n\n<context uri="file:///repo/b.ts">\nconst b = 1;\n</context>',
    );
  });

  it("is empty for a missing or malformed prompt", () => {
    expect(promptToText(undefined)).toBe("");
    expect(promptToText([{ type: "text" }, null, 3])).toBe("");
  });
});

describe("tool mapping", () => {
  it("picks an ACP kind per tool family", () => {
    expect(toolKind("os.fs.read")).toBe("read");
    expect(toolKind("os.fs.write")).toBe("edit");
    expect(toolKind("os.fs.edit")).toBe("edit");
    expect(toolKind("os.fs.trash")).toBe("delete");
    expect(toolKind("os.fs.move")).toBe("move");
    expect(toolKind("os.shell.run")).toBe("execute");
    expect(toolKind("os.git.status")).toBe("read");
    expect(toolKind("os.git.commit")).toBe("execute");
    expect(toolKind("os.web.search")).toBe("search");
    expect(toolKind("os.web.fetch")).toBe("fetch");
    expect(toolKind("browser.navigate")).toBe("fetch");
    expect(toolKind("memory.notes.recall")).toBe("read");
    expect(toolKind("mcp.github.create_issue")).toBe("other");
  });

  it("titles a call by its main argument, on one short line", () => {
    expect(toolTitle({ tool: "os.shell.run", args: { command: "npm test\nnpm run lint" } })).toBe(
      "os.shell.run: npm test",
    );
    expect(toolTitle({ tool: "os.fs.read", args: { path: "/repo/a.ts" } })).toBe("os.fs.read: /repo/a.ts");
    expect(toolTitle({ tool: "os.proc.list", args: {} })).toBe("os.proc.list");
    expect(toolTitle({ tool: "os.shell.run", args: { command: "x".repeat(300) } }).length).toBe(120);
  });

  it("sends the plan whole, done as completed", () => {
    expect(
      planUpdate({
        updatedAt: 1,
        items: [
          { step: "Read the code", status: "done" },
          { step: "Fix it", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      }),
    ).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", priority: "medium", status: "completed" },
        { content: "Fix it", priority: "medium", status: "in_progress" },
        { content: "Test", priority: "medium", status: "pending" },
      ],
    });
  });

  it("maps loop reasons to stop reasons", () => {
    expect(stopReason("reply")).toBe("end_turn");
    expect(stopReason("finish")).toBe("end_turn");
    expect(stopReason("failed")).toBe("end_turn");
    expect(stopReason("max_steps")).toBe("max_turn_requests");
    expect(stopReason("cancelled")).toBe("cancelled");
  });
});

describe("AcpTurnTranslator", () => {
  it("opens and closes tool calls with stable ids, batch by batch", () => {
    const t = new AcpTurnTranslator();
    t.translate({ type: "step_started", stepIndex: 0 } as AgentLoopEvent);
    const opened = [
      ...t.translate(llm({ type: "tool_call_parsed", call: { tool: "os.fs.read", args: { path: "/a" } }, batchIndex: 0, batchSize: 2 })),
      ...t.translate(llm({ type: "tool_call_parsed", call: { tool: "os.shell.run", args: { command: "ls" } }, batchIndex: 1, batchSize: 2 })),
    ];
    expect(opened).toMatchObject([
      { sessionUpdate: "tool_call", toolCallId: "call-1", kind: "read", status: "pending", locations: [{ path: "/a" }] },
      { sessionUpdate: "tool_call", toolCallId: "call-2", kind: "execute", title: "os.shell.run: ls" },
    ]);
    expect(t.openCallFor("os.shell.run")).toBe("call-2");
    const closed = [
      ...t.translate(llm({ type: "tool_call_executed", result: result("os.shell.run", "error", "exit 1"), batchIndex: 1, batchSize: 2 })),
      ...t.translate(llm({ type: "tool_call_executed", result: result("os.fs.read", "ok", ""), batchIndex: 0, batchSize: 2 })),
    ];
    expect(closed).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-2",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
    ]);
    expect(t.openCallFor("os.shell.run")).toBeUndefined();
  });

  it("does not show reply, finish or plan.update as tool calls", () => {
    const t = new AcpTurnTranslator();
    for (const tool of ["reply", "finish", "plan.update", "ask_user"]) {
      expect(t.translate(llm({ type: "tool_call_parsed", call: { tool, args: {} }, batchIndex: 0, batchSize: 1 }))).toEqual([]);
      expect(t.translate(llm({ type: "tool_call_executed", result: result(tool, "ok", "x"), batchIndex: 0, batchSize: 1 }))).toEqual([]);
    }
  });

  it("streams reply deltas and does not repeat the closing reply", () => {
    const t = new AcpTurnTranslator();
    expect(t.translate(llm({ type: "assistant_delta", text: "Hel" }))).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    ]);
    t.translate(llm({ type: "assistant_delta", text: "lo" }));
    expect(t.translate(llm({ type: "assistant_reply", text: "Hello" }))).toEqual([]);
    // The next reply in the same turn was not streamed: send it whole.
    expect(t.translate(llm({ type: "assistant_reply", text: "Done." }))).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    ]);
  });

  it("sends reasoning as thought chunks and a failed loop as a message", () => {
    const t = new AcpTurnTranslator();
    expect(t.translate(llm({ type: "reasoning_delta", stepIndex: 0, text: "hmm" }))).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
    expect(
      t.translate({ type: "loop_failed", error: new Error("model unreachable"), category: "network" } as unknown as AgentLoopEvent),
    ).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nError: model unreachable" } }]);
  });
});

describe("permissions", () => {
  it("offers once, this chat, always and deny for a grantable shell command", () => {
    const options = permissionOptions(shellRequest, true);
    expect(options.map((o) => [o.optionId, o.kind])).toEqual([
      [OPTION_ALLOW, "allow_once"],
      [OPTION_ALLOW_SESSION, "allow_always"],
      [OPTION_ALLOW_ALWAYS, "allow_always"],
      [OPTION_REJECT, "reject_once"],
    ]);
    expect(options[2]!.name).toMatch(/^Always allow/);
  });

  it("offers only once and deny for a dangerous command with no rule store", () => {
    const options = permissionOptions({ ...shellRequest, category: "shell_dangerous" }, false);
    expect(options.map((o) => o.optionId)).toEqual([OPTION_ALLOW, OPTION_REJECT]);
  });

  it("maps each answer to the gate decision", () => {
    const pick = (optionId: string) => ({ outcome: "selected", optionId });
    expect(permissionDecision(shellRequest, true, pick(OPTION_ALLOW))).toEqual({ approvalId: "ap-1", approved: true });
    expect(permissionDecision(shellRequest, true, pick(OPTION_ALLOW_SESSION))).toEqual({
      approvalId: "ap-1",
      approved: true,
      grant: "category",
    });
    expect(permissionDecision(shellRequest, true, pick(OPTION_ALLOW_ALWAYS))).toEqual({
      approvalId: "ap-1",
      approved: true,
      grant: "always",
    });
    expect(permissionDecision(shellRequest, true, pick(OPTION_REJECT))).toEqual({ approvalId: "ap-1", approved: false });
  });

  it("denies, as nobody's decision, a cancelled, unknown or not-offered answer", () => {
    for (const outcome of [{ outcome: "cancelled" }, undefined, { outcome: "selected", optionId: "bogus" }]) {
      expect(permissionDecision(shellRequest, true, outcome)).toMatchObject({ approved: false, automatic: true });
    }
    // "Always" was not offered (no rule store), so it cannot be picked.
    expect(permissionDecision(shellRequest, false, { outcome: "selected", optionId: OPTION_ALLOW_ALWAYS })).toMatchObject({
      approved: false,
      automatic: true,
    });
  });

  it("shows a question's options as buttons and answers with the label", () => {
    const question: ApprovalRequest = {
      approvalId: "q-1",
      sessionId: "s-1",
      tool: "ask_user",
      category: "user_question",
      reason: "Which database?",
      question: {
        prompt: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        multiSelect: false,
        allowOther: false,
      },
    } as ApprovalRequest;
    expect(permissionOptions(question, false).map((o) => o.name)).toEqual(["Postgres", "SQLite", "Skip the question"]);
    expect(permissionDecision(question, false, { outcome: "selected", optionId: "answer-1" })).toEqual({
      approvalId: "q-1",
      approved: true,
      answer: { selected: ["SQLite"] },
    });
    expect(permissionToolCall(question, "approval-q-1")).toMatchObject({ title: "Which database?", kind: "think" });
  });

  it("describes the gated call for the prompt", () => {
    expect(permissionToolCall(shellRequest, "call-3")).toEqual({
      toolCallId: "call-3",
      title: "os.shell.run: run a command",
      kind: "execute",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: "run a command\n\nnpm test" } }],
    });
  });
});
