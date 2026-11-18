import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "../approval/approval-gate.js";
import type { AgentLoopEvent, AgentLoopReason } from "../agent/agent-contract.js";
import type { SessionState } from "../session/index.js";
import { ACP_SETUP_METHOD_ID, AcpServer, type AcpRuntime, type AcpRuntimeHandlers } from "./acp-server.js";

type Script = (ctx: {
  emit: (event: AgentLoopEvent) => void;
  ask: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  signal: AbortSignal;
}) => Promise<AgentLoopReason>;

function fakeRuntime(script: Script) {
  let handlers: AcpRuntimeHandlers | null = null;
  const waiting = new Map<string, (d: ApprovalDecision) => void>();
  const resolved: ApprovalDecision[] = [];
  const denied: string[] = [];
  const prompts: string[] = [];
  let sessions = 0;
  const runtime: AcpRuntime = {
    approvals: {
      canGrantAlways: () => false,
      resolve: (decision) => {
        const done = waiting.get(decision.approvalId);
        if (!done) return false;
        waiting.delete(decision.approvalId);
        resolved.push(decision);
        done(decision);
        return true;
      },
      denyPendingForSession: (sessionId) => {
        denied.push(sessionId);
        for (const [id, done] of waiting) {
          waiting.delete(id);
          done({ approvalId: id, approved: false, automatic: true });
        }
        return 0;
      },
    },
    sessionStore: { load: () => null },
    createSession: () => ({ id: `s-${++sessions}` }) as SessionState,
    runTurn: async (session, text, options) => {
      prompts.push(text);
      const reason = await script({
        emit: options.eventHook,
        signal: options.signal,
        ask: (request) =>
          new Promise<ApprovalDecision>((resolve) => {
            waiting.set(request.approvalId, resolve);
            handlers!.onApprovalRequest(request);
          }),
      });
      return { session, reason };
    },
    shutdown: async () => undefined,
  };
  const createRuntime = async (_cwd: string, h: AcpRuntimeHandlers): Promise<AcpRuntime> => {
    handlers = h;
    return runtime;
  };
  return { createRuntime, resolved, denied, prompts };
}

function fakeClient(answer: (params: Record<string, unknown>) => Promise<unknown> | unknown = () => ({})) {
  const updates: Array<Record<string, unknown>> = [];
  const permissionRequests: Array<Record<string, unknown>> = [];
  return {
    updates,
    permissionRequests,
    notify: (method: string, params: unknown) => {
      if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
    },
    request: async (method: string, params: unknown) => {
      expect(method).toBe("session/request_permission");
      permissionRequests.push(params as Record<string, unknown>);
      return answer(params as Record<string, unknown>);
    },
  };
}

function server(createRuntime: ReturnType<typeof fakeRuntime>["createRuntime"]) {
  return new AcpServer({
    createRuntime,
    version: "1.2.3",
    setupCommand: { command: "/usr/local/bin/atomic-agent", args: ["acp", "--setup"] },
  });
}

const llm = (event: unknown): AgentLoopEvent => ({ type: "llm_event", event }) as unknown as AgentLoopEvent;

const shellRequest = (sessionId: string): ApprovalRequest => ({
  approvalId: "ap-1",
  sessionId,
  tool: "os.shell.run",
  category: "shell",
  reason: "run a command",
  preview: "npm test",
});

describe("AcpServer (ATO-543)", () => {
  it("answers initialize with v1 and a terminal auth method the ACP registry accepts", async () => {
    const s = server(fakeRuntime(async () => "reply").createRuntime);
    const result = (await s.handleRequest("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
      protocolVersion: number;
      agentInfo: { name: string; version: string };
      agentCapabilities: { loadSession: boolean };
      authMethods: Array<{ id: string; type?: string; args?: string[]; _meta?: Record<string, unknown> }>;
    };
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo).toMatchObject({ name: "atomic-agent", version: "1.2.3" });
    expect(result.agentCapabilities.loadSession).toBe(false);
    // The registry's check: at least one method of type agent or terminal.
    expect(result.authMethods.some((m) => m.type === "agent" || m.type === "terminal")).toBe(true);
    expect(result.authMethods[0]).toMatchObject({
      id: ACP_SETUP_METHOD_ID,
      type: "terminal",
      args: ["--setup"],
      _meta: { "terminal-auth": { command: "/usr/local/bin/atomic-agent", args: ["acp", "--setup"] } },
    });
    await expect(s.handleRequest("authenticate", { methodId: ACP_SETUP_METHOD_ID })).resolves.toEqual({});
    await expect(s.handleRequest("authenticate", { methodId: "other" })).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects initialize without a protocol version and unknown methods", async () => {
    const s = server(fakeRuntime(async () => "reply").createRuntime);
    await expect(s.handleRequest("initialize", {})).rejects.toMatchObject({ code: -32602 });
    await expect(s.handleRequest("session/load", {})).rejects.toMatchObject({ code: -32601 });
  });

  it("needs an absolute cwd for session/new and a known session for a prompt", async () => {
    const s = server(fakeRuntime(async () => "reply").createRuntime);
    await expect(s.handleRequest("session/new", { cwd: "relative", mcpServers: [] })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      s.handleRequest("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("runs a prompt, streams updates and ends the turn", async () => {
    const rt = fakeRuntime(async ({ emit }) => {
      emit({ type: "step_started", stepIndex: 0 } as AgentLoopEvent);
      emit(llm({ type: "tool_call_parsed", call: { tool: "os.fs.read", args: { path: "/repo/a" } }, batchIndex: 0, batchSize: 1 }));
      emit(llm({ type: "tool_call_executed", result: { tool: "os.fs.read", status: "ok", summary: "", details: {}, truncated: false }, batchIndex: 0, batchSize: 1 }));
      emit(llm({ type: "assistant_reply", text: "All good." }));
      return "reply";
    });
    const s = server(rt.createRuntime);
    const client = fakeClient();
    s.attach(client);
    const { sessionId } = (await s.handleRequest("session/new", { cwd: "/repo", mcpServers: [] })) as { sessionId: string };
    const result = await s.handleRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "check a" }],
    });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(rt.prompts).toEqual(["check a"]);
    expect(client.updates.map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);
  });

  it("asks the client for permission and resolves the gate with its answer", async () => {
    let decision: ApprovalDecision | undefined;
    const rt = fakeRuntime(async ({ ask }) => {
      decision = await ask(shellRequest("s-1"));
      return "reply";
    });
    const s = server(rt.createRuntime);
    const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: "allow-session" } }));
    s.attach(client);
    await s.handleRequest("session/new", { cwd: "/repo", mcpServers: [] });
    await s.handleRequest("session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "test it" }] });
    expect(client.permissionRequests).toHaveLength(1);
    expect(client.permissionRequests[0]).toMatchObject({
      sessionId: "s-1",
      toolCall: { toolCallId: "approval-ap-1", kind: "execute" },
    });
    expect(decision).toEqual({ approvalId: "ap-1", approved: true, grant: "category" });
  });

  it("routes a worker session's approval to the one running chat in that folder", async () => {
    const rt = fakeRuntime(async ({ ask }) => {
      await ask(shellRequest("worker-7"));
      return "reply";
    });
    const s = server(rt.createRuntime);
    const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
    s.attach(client);
    await s.handleRequest("session/new", { cwd: "/repo", mcpServers: [] });
    await s.handleRequest("session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "go" }] });
    expect(client.permissionRequests[0]).toMatchObject({ sessionId: "s-1" });
    expect(rt.resolved).toEqual([{ approvalId: "ap-1", approved: true }]);
  });

  it("cancels a running prompt: denies its approval and stops with cancelled", async () => {
    let decision: ApprovalDecision | undefined;
    const rt = fakeRuntime(async ({ ask, signal }) => {
      decision = await ask(shellRequest("s-1"));
      return signal.aborted ? "cancelled" : "reply";
    });
    const s = server(rt.createRuntime);
    // The client never answers on its own; the cancel settles it.
    const client = fakeClient(() => new Promise(() => undefined));
    s.attach(client);
    await s.handleRequest("session/new", { cwd: "/repo", mcpServers: [] });
    const prompt = s.handleRequest("session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "go" }] });
    await new Promise((r) => setTimeout(r, 0));
    s.handleNotification("session/cancel", { sessionId: "s-1" });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(rt.denied).toEqual(["s-1"]);
    expect(decision).toMatchObject({ approved: false });
  });

  it("denies an approval when the client's permission request fails", async () => {
    let decision: ApprovalDecision | undefined;
    const rt = fakeRuntime(async ({ ask }) => {
      decision = await ask(shellRequest("s-1"));
      return "reply";
    });
    const s = server(rt.createRuntime);
    s.attach(
      fakeClient(() => {
        throw new Error("client does not support it");
      }),
    );
    await s.handleRequest("session/new", { cwd: "/repo", mcpServers: [] });
    await s.handleRequest("session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "go" }] });
    expect(decision).toMatchObject({ approved: false, automatic: true });
  });

  it("boots one runtime per folder", async () => {
    let boots = 0;
    const rt = fakeRuntime(async () => "reply");
    const s = server(async (cwd, h) => {
      boots++;
      return rt.createRuntime(cwd, h);
    });
    await s.handleRequest("session/new", { cwd: "/a", mcpServers: [] });
    await s.handleRequest("session/new", { cwd: "/a", mcpServers: [] });
    await s.handleRequest("session/new", { cwd: "/b", mcpServers: [] });
    expect(boots).toBe(2);
  });
});
