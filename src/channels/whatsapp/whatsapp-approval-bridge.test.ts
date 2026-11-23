import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { WhatsAppApprovalBridge } from "./whatsapp-approval-bridge.js";

const CHAT = "15550002222@s.whatsapp.net";
const request = {
  approvalId: "ap-1",
  sessionId: "s-1",
  tool: "os.shell",
  category: "shell",
  reason: "runs a command",
  preview: "rm -rf build",
} as unknown as ApprovalRequest;

function makeBridge(over: { canGrantAlways?: boolean; settled?: boolean } = {}) {
  const sent: Array<{ chat: string; text: string }> = [];
  const resolve = vi.fn(() => over.settled ?? true);
  const bridge = new WhatsAppApprovalBridge({
    send: async (chat, text) => {
      sent.push({ chat, text });
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

describe("WhatsAppApprovalBridge", () => {
  it("posts a text prompt with the code to the chat and resolves on yes <code>", async () => {
    const { bridge, sent, resolve } = makeBridge();
    bridge.handlerFor(CHAT)(request);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.chat).toBe(CHAT);
    expect(sent[0]?.text).toContain('Reply "yes K7Q2" to approve or "no K7Q2" to deny.');
    expect(sent[0]?.text).toContain("rm -rf build");
    expect(bridge.tryAnswer("yes k7q2", CHAT)).toBe("Approved.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: true, reason: "approved from WhatsApp" });
    expect(bridge.tryAnswer("yes K7Q2", CHAT)).toMatch(/No pending approval/);
  });

  it("denies on no <code>", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor(CHAT)(request);
    expect(bridge.tryAnswer("No K7Q2", CHAT)).toBe("Denied.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: false });
  });

  it("does not treat a bare yes or normal text as an answer", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor(CHAT)(request);
    expect(bridge.tryAnswer("yes", CHAT)).toBeNull();
    expect(bridge.tryAnswer("yes please deploy it", CHAT)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("only accepts the answer in the chat the prompt went to", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor("12036300@g.us")(request);
    expect(bridge.tryAnswer("yes K7Q2", CHAT)).toMatch(/No pending approval/);
    expect(resolve).not.toHaveBeenCalled();
    expect(bridge.tryAnswer("yes K7Q2", "12036300@g.us")).toBe("Approved.");
  });

  it("offers always only when the gate can save a rule", () => {
    const plain = makeBridge();
    plain.bridge.handlerFor(CHAT)(request);
    expect(plain.bridge.tryAnswer("always K7Q2", CHAT)).toMatch(/not offered/);

    const withAlways = makeBridge({ canGrantAlways: true });
    withAlways.bridge.handlerFor(CHAT)(request);
    expect(withAlways.bridge.tryAnswer("always K7Q2", CHAT)).toMatch(/^Approved\. Saved:/);
    expect(withAlways.resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true, grant: "always" }));
  });

  it("says so when the request already expired", () => {
    const { bridge } = makeBridge({ settled: false });
    bridge.handlerFor(CHAT)(request);
    expect(bridge.tryAnswer("yes K7Q2", CHAT)).toMatch(/already expired/);
  });
});
