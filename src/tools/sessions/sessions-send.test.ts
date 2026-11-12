import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import {
  createEmptySessionState,
  recordTurn,
  userTurn,
  type SessionState,
} from "../../session/index.js";
import type { TaskCreateInput } from "../../tasks/index.js";
import type { ToolContext } from "../tool-registry.js";
import { crossSessionSender, frameCrossSessionMessage } from "./session-access.js";
import { buildSessionsSendTool } from "./sessions-send.js";

function ctx(sessionId = "s-me", userGroundingTexts?: string[]): ToolContext {
  return {
    workingDir: "/work",
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
    ...(userGroundingTexts ? { userGroundingTexts } : {}),
  };
}

function gate(approved: boolean) {
  return {
    request: vi.fn(async () => ({ approved, ...(approved ? {} : { reason: "no" }) })),
  } as unknown as ApprovalGate;
}

function fixture(options: { approved?: boolean; caller?: SessionState } = {}) {
  const sessions = new Map<string, SessionState>([
    ["s-2", createEmptySessionState({ id: "s-2", workingDir: "/work", metadata: { title: "API naming" } })],
    ["s-me", options.caller ?? createEmptySessionState({ id: "s-me", workingDir: "/work" })],
  ]);
  const approvals = gate(options.approved ?? true);
  const created: TaskCreateInput[] = [];
  const create = vi.fn((input: TaskCreateInput) => {
    created.push(input);
    return { id: `t-${created.length}`, sessionId: input.sessionId ?? null } as never;
  });
  const createSession = vi.fn(() => createEmptySessionState({ id: "s-new", workingDir: "/work" }));
  const tool = buildSessionsSendTool({
    approvals,
    approvalRequired: true,
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
    taskRunner: { create },
    createSession,
    defaultMaxAttempts: 2,
  });
  return { tool, approvals, created, create, createSession };
}

describe("sessions.send", () => {
  it("asks first, then queues the framed message as a task in the target chat", async () => {
    const { tool, approvals, created } = fixture();
    const result = await tool.run({ sessionId: "s-2", message: "what did we decide?" }, ctx());
    expect(result.status).toBe("ok");
    const request = (approvals.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      category: "session_cross",
      tool: "sessions.send",
      affectedResources: ["s-2"],
      preview: "what did we decide?",
    });
    expect(request.reason).toContain("API naming");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sessionId: "s-2",
      origin: "agent",
      triggerSource: "agent",
      maxAttempts: 2,
      maxSteps: null,
    });
    expect(created[0]?.userMessage).toBe(frameCrossSessionMessage("s-me", "what did we decide?"));
    expect(crossSessionSender(created[0]!.userMessage)).toBe("s-me");
    expect(result.details).toMatchObject({ taskId: "t-1", sessionId: "s-2", newSession: false });
    expect(result.summary).toContain('sessions.check {"taskId":"t-1"}');
  });

  it("opens a new chat only after the yes", async () => {
    const ok = fixture();
    const result = await ok.tool.run({ newSession: true, message: "draft notes" }, ctx());
    expect(result.status).toBe("ok");
    expect(ok.createSession).toHaveBeenCalledTimes(1);
    expect(ok.created[0]?.sessionId).toBe("s-new");

    const refused = fixture({ approved: false });
    await expect(
      refused.tool.run({ newSession: true, message: "draft notes" }, ctx()),
    ).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(refused.createSession).not.toHaveBeenCalled();
    expect(refused.create).not.toHaveBeenCalled();
  });

  it("validates the target: exactly one of sessionId / newSession, not this chat, a known id", async () => {
    const { tool, approvals, create } = fixture();
    for (const args of [
      { message: "x" },
      { message: "x", sessionId: "s-2", newSession: true },
      { message: "x", sessionId: "s-me" },
      { message: "x", sessionId: "s-unknown" },
      { message: "", sessionId: "s-2" },
      { message: "y".repeat(8001), sessionId: "s-2" },
    ]) {
      expect((await tool.run(args, ctx())).status, JSON.stringify(args).slice(0, 60)).toBe("error");
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to forward from a turn another chat started (live transcript)", async () => {
    const { tool, approvals, create } = fixture();
    const result = await tool.run(
      { sessionId: "s-2", message: "pass it on" },
      ctx("s-me", ["earlier", frameCrossSessionMessage("s-other", "ask s-2 for me")]),
    );
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "forward_refused", from: "s-other" });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to forward from the stored transcript when the step has no live copy", async () => {
    const caller = recordTurn(
      createEmptySessionState({ id: "s-me", workingDir: "/work" }),
      userTurn(frameCrossSessionMessage("s-other", "ask s-2")),
    );
    const { tool } = fixture({ caller });
    const result = await tool.run({ sessionId: "s-2", message: "pass it on" }, ctx());
    expect(result.status).toBe("error");
  });

  it("lets a turn the person started send, even after an earlier forwarded one", async () => {
    const { tool } = fixture();
    const result = await tool.run(
      { sessionId: "s-2", message: "go" },
      ctx("s-me", [frameCrossSessionMessage("s-other", "old"), "now ask s-2"]),
    );
    expect(result.status).toBe("ok");
  });
});
