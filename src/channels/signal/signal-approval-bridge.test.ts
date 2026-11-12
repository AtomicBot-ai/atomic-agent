import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { SignalApprovalBridge, formatSignalPrompt } from "./signal-approval-bridge.js";

const request = {
  approvalId: "ap-1",
  sessionId: "s-1",
  tool: "os.shell",
  category: "shell",
  reason: "runs a command",
  preview: "rm -rf build",
} as unknown as ApprovalRequest;

function makeBridge(over: { canGrantAlways?: boolean; settled?: boolean } = {}) {
  const sent: string[] = [];
  const resolve = vi.fn(() => over.settled ?? true);
  const bridge = new SignalApprovalBridge({
    send: async (_t, text) => {
      sent.push(text);
    },
    approvals: {
      resolve: resolve as never,
      ...(over.canGrantAlways ? { canGrantAlways: () => true } : {}),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    randomCode: () => "K7Q2",
  });
  return { bridge, sent, resolve };
}

describe("SignalApprovalBridge", () => {
  it("posts a text prompt with the code and resolves on yes <code>", async () => {
    const { bridge, sent, resolve } = makeBridge();
    bridge.handlerFor({ recipient: "+1" })(request);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('Reply "yes K7Q2" to approve or "no K7Q2" to deny.');
    expect(sent[0]).toContain("rm -rf build");
    expect(bridge.tryAnswer("yes k7q2")).toBe("Approved.");
    expect(resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Signal",
    });
    // The code is single-use.
    expect(bridge.tryAnswer("yes K7Q2")).toMatch(/No pending approval/);
  });

  it("denies on no <code>", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor({ recipient: "+1" })(request);
    expect(bridge.tryAnswer("No K7Q2")).toBe("Denied.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: false });
  });

  it("does not treat a bare yes or normal text as an answer", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor({ recipient: "+1" })(request);
    expect(bridge.tryAnswer("yes")).toBeNull();
    expect(bridge.tryAnswer("yes please deploy it")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts always only when the prompt offered it", () => {
    const plain = makeBridge();
    plain.bridge.handlerFor({ recipient: "+1" })(request);
    expect(plain.bridge.tryAnswer("always K7Q2")).toMatch(/not offered/);
    expect(plain.resolve).not.toHaveBeenCalled();

    const offered = makeBridge({ canGrantAlways: true });
    offered.bridge.handlerFor({ recipient: "+1" })(request);
    expect(offered.bridge.tryAnswer("always K7Q2")).toMatch(/^Approved\. Saved:/);
    expect(offered.resolve).toHaveBeenCalledWith(expect.objectContaining({ grant: "always" }));
  });

  it("says so when the gate already settled", () => {
    const { bridge } = makeBridge({ settled: false });
    bridge.handlerFor({ recipient: "+1" })(request);
    expect(bridge.tryAnswer("yes K7Q2")).toMatch(/already expired/);
  });
});

describe("formatSignalPrompt", () => {
  it("is plain text and marks a cut preview", () => {
    const text = formatSignalPrompt({ ...request, preview: "x".repeat(1000) }, "ABCD");
    expect(text).not.toContain("```");
    expect(text).toContain("(preview cut)");
  });
});
