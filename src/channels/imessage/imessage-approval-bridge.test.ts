import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { formatApprovalPrompt, ImessageApprovalBridge } from "./imessage-approval-bridge.js";
import type { ImessageTarget } from "./imsg-send.js";

const request = {
  approvalId: "appr-1",
  sessionId: "s-1",
  tool: "os.shell.run",
  category: "shell",
  reason: "Runs a command",
  preview: "rm -rf ./build",
} as unknown as ApprovalRequest;

function setup(resolveResult = true) {
  const sent: Array<{ target: ImessageTarget; text: string }> = [];
  const resolve = vi.fn(() => resolveResult);
  const codes = ["1234", "1234", "5678"];
  const bridge = new ImessageApprovalBridge({
    approvals: { resolve },
    logger: { warn: vi.fn() } as never,
    send: async (target, text) => {
      sent.push({ target, text });
    },
    randomCode: () => codes.shift() ?? "9999",
  });
  return { bridge, sent, resolve };
}

const target: ImessageTarget = { kind: "handle", handle: "+14155551212" };

describe("ImessageApprovalBridge", () => {
  it("posts a prompt with a code to the chat that asked", async () => {
    const t = setup();
    t.bridge.handlerFor(42, target)(request);
    await Promise.resolve();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.target).toEqual(target);
    expect(t.sent[0]!.text).toContain('Reply "yes 1234" to approve or "no 1234" to deny.');
    expect(t.sent[0]!.text).toContain("rm -rf ./build");
  });

  it("approves on `yes <code>` and denies on `no <code>`", () => {
    const t = setup();
    t.bridge.handlerFor(42, target)(request);
    t.bridge.handlerFor(42, target)({ ...request, approvalId: "appr-2" });
    expect(t.bridge.handleReply(42, "Yes 1234")).toBe("Approved (1234).");
    expect(t.resolve).toHaveBeenLastCalledWith({ approvalId: "appr-1", approved: true, reason: "approved from iMessage" });
    // The duplicate random code was skipped, so the second prompt got 5678.
    expect(t.bridge.handleReply(42, "no 5678")).toBe("Denied (5678).");
    expect(t.resolve).toHaveBeenLastCalledWith({ approvalId: "appr-2", approved: false });
    expect(t.bridge.size()).toBe(0);
  });

  it("never treats a bare yes, or a yes inside a sentence, as an approval", () => {
    const t = setup();
    t.bridge.handlerFor(42, target)(request);
    expect(t.bridge.handleReply(42, "yes")).toBeNull();
    expect(t.bridge.handleReply(42, "yes 1234 and also delete the logs")).toBeNull();
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it("refuses a code from another chat or one already used", () => {
    const t = setup();
    t.bridge.handlerFor(42, target)(request);
    expect(t.bridge.handleReply(7, "yes 1234")).toMatch(/No open approval/);
    expect(t.bridge.handleReply(42, "yes 1234")).toBe("Approved (1234).");
    expect(t.bridge.handleReply(42, "yes 1234")).toMatch(/No open approval/);
    expect(t.resolve).toHaveBeenCalledTimes(1);
  });

  it("says so when the gate already settled the request", () => {
    const t = setup(false);
    t.bridge.handlerFor(42, target)(request);
    expect(t.bridge.handleReply(42, "yes 1234")).toMatch(/already expired/);
  });
});

describe("formatApprovalPrompt", () => {
  it("cuts a long preview and keeps the reply instructions last", () => {
    const text = formatApprovalPrompt({ ...request, preview: "x".repeat(2000) }, "4821");
    expect(text).toContain("(preview cut)");
    expect(text.split("\n").at(-1)).toBe('Reply "yes 4821" to approve or "no 4821" to deny.');
  });
});
