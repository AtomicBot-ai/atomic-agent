import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { createEmptySessionState, type SessionChatLine } from "../../session/index.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSessionsReadTool } from "./sessions-read.js";

function ctx(sessionId = "s-me"): ToolContext {
  return { workingDir: "/work", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

function gate(approved: boolean) {
  return {
    request: vi.fn(async () => ({ approved, ...(approved ? {} : { reason: "no" }) })),
  } as unknown as ApprovalGate;
}

function store(lines: SessionChatLine[]) {
  const state = createEmptySessionState({
    id: "s-2",
    workingDir: "/work",
    metadata: { title: "API naming" },
  });
  return {
    load: vi.fn((id: string) => (id === "s-2" || id === "s-me" ? { ...state, id } : null)),
    listChatLines: vi.fn(() => lines),
  };
}

describe("sessions.read", () => {
  it("asks under session_cross, then shows only the person's words and the agent's replies", async () => {
    const approvals = gate(true);
    const sessionStore = store([
      { kind: "user", text: "pick names for the endpoints" },
      { kind: "assistant_reply", text: "use /v2/items" },
    ]);
    const tool = buildSessionsReadTool({ approvals, approvalRequired: true, sessionStore });
    const result = await tool.run({ sessionId: "s-2" }, ctx());
    expect(result.status).toBe("ok");
    const request = (approvals.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      category: "session_cross",
      tool: "sessions.read",
      affectedResources: ["s-2"],
    });
    expect(request.reason).toContain("API naming");
    expect(result.summary).toContain("person: pick names for the endpoints");
    expect(result.summary).toContain("agent: use /v2/items");
    // The other chat's text is framed as data by the registry.
    expect(tool.untrustedOutput).toBe("another chat");
  });

  it("reads the caller's own chat without asking", async () => {
    const approvals = gate(true);
    const tool = buildSessionsReadTool({ approvals, approvalRequired: true, sessionStore: store([]) });
    const result = await tool.run({ sessionId: "s-me" }, ctx("s-me"));
    expect(result.status).toBe("ok");
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("returns the last `limit` messages and clips a long one", async () => {
    const lines: SessionChatLine[] = Array.from({ length: 30 }, (_, i) => ({
      kind: i % 2 === 0 ? "user" : "assistant_reply",
      text: i === 29 ? "y".repeat(5000) : `m${i}`,
    }));
    const tool = buildSessionsReadTool({ approvals: gate(true), approvalRequired: true, sessionStore: store(lines) });
    const result = await tool.run({ sessionId: "s-2", limit: 3 }, ctx());
    expect(result.details).toMatchObject({ shown: 3, total: 30 });
    expect(result.summary).not.toContain("m26");
    expect(result.summary).toContain("m27");
    expect(result.summary).not.toContain("y".repeat(2001));
  });

  it("refuses an unknown id or a missing one without asking", async () => {
    const approvals = gate(true);
    const tool = buildSessionsReadTool({ approvals, approvalRequired: true, sessionStore: store([]) });
    expect((await tool.run({ sessionId: "s-nope" }, ctx())).status).toBe("error");
    expect((await tool.run({}, ctx())).status).toBe("error");
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("reads nothing when the operator says no", async () => {
    const sessionStore = store([{ kind: "user", text: "secret" }]);
    const tool = buildSessionsReadTool({ approvals: gate(false), approvalRequired: true, sessionStore });
    await expect(tool.run({ sessionId: "s-2" }, ctx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(sessionStore.listChatLines).not.toHaveBeenCalled();
  });
});
