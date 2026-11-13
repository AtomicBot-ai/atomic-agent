import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import {
  approveCrossSession,
  chatName,
  crossSessionSender,
  frameCrossSessionMessage,
  limitArg,
  oneLine,
} from "./session-access.js";

function gate(approved: boolean) {
  return {
    request: vi.fn(async () => ({ approved, ...(approved ? {} : { reason: "no" }) })),
  } as unknown as ApprovalGate;
}

describe("cross-chat message framing", () => {
  it("round-trips the sender through the header", () => {
    const framed = frameCrossSessionMessage("s-abc", "what did we decide?");
    expect(framed.endsWith("\n\nwhat did we decide?")).toBe(true);
    expect(framed).toContain("not from the person");
    expect(crossSessionSender(framed)).toBe("s-abc");
  });

  it("reads no sender from ordinary text or a forged header without an id", () => {
    expect(crossSessionSender("hello")).toBeNull();
    expect(crossSessionSender(frameCrossSessionMessage("", "x"))).toBeNull();
    expect(crossSessionSender(frameCrossSessionMessage("two words", "x"))).toBeNull();
  });
});

describe("chat names", () => {
  it("prefers the title, falls back to the opening words, flattens and clips", () => {
    expect(chatName({ title: "Release notes", firstPrompt: "hi" })).toBe("Release notes");
    expect(chatName({ title: null, firstPrompt: "line one\nline two" })).toBe("line one line two");
    expect(chatName({ title: null, firstPrompt: null })).toBe("(untitled)");
    expect(oneLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("clamps limits and falls back on junk", () => {
    expect(limitArg(undefined, 20, 50)).toBe(20);
    expect(limitArg(0, 20, 50)).toBe(20);
    expect(limitArg(7.9, 20, 50)).toBe(7);
    expect(limitArg(500, 20, 50)).toBe(50);
  });
});

describe("approveCrossSession", () => {
  it("never asks about the caller's own chat", async () => {
    const approvals = gate(true);
    await approveCrossSession(
      { approvals, approvalRequired: true },
      { tool: "sessions.read", callerSessionId: "s-1", targetSessionId: "s-1", reason: "r" },
      new AbortController().signal,
    );
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("asks under session_cross naming the target, and throws on a no", async () => {
    const approvals = gate(true);
    await approveCrossSession(
      { approvals, approvalRequired: true },
      { tool: "sessions.read", callerSessionId: "s-1", targetSessionId: "s-2", reason: "read it" },
      new AbortController().signal,
    );
    const request = (approvals.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      sessionId: "s-1",
      tool: "sessions.read",
      category: "session_cross",
      reason: "read it",
      affectedResources: ["s-2"],
    });
    await expect(
      approveCrossSession(
        { approvals: gate(false), approvalRequired: true },
        { tool: "sessions.send", callerSessionId: "s-1", targetSessionId: null, reason: "r" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ApprovalDeniedError);
  });
});
