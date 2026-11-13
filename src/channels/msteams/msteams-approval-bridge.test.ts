import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { TeamsApprovalBridge, approvalCard, conversationRoot } from "./msteams-approval-bridge.js";
import type { TeamsTarget } from "./msteams-types.js";

const OWNER = "aad-owner";
const CONV = "19:abc@thread.tacv2;messageid=100";
const target: TeamsTarget = { serviceUrl: "https://smba.invalid/", conversationId: CONV, replyToId: "100" };

const request = {
  approvalId: "appr-1",
  sessionId: "s1",
  tool: "shell.exec",
  category: "shell",
  reason: "Run a command",
  preview: "rm -rf build",
} as unknown as ApprovalRequest;

function makeBridge(over: { canGrantAlways?: boolean; resolve?: boolean } = {}) {
  const api = {
    sendActivity: vi.fn(async () => "card-1"),
    updateActivity: vi.fn(async () => undefined),
  };
  const resolve = vi.fn(() => over.resolve ?? true);
  const bridge = new TeamsApprovalBridge({
    api,
    approvals: { resolve, canGrantAlways: () => over.canGrantAlways ?? false },
    logger: { warn: vi.fn() },
    ownerIds: () => [OWNER],
    makeCode: () => "abc123",
  });
  return { bridge, api, resolve };
}

async function posted(bridge: TeamsApprovalBridge): Promise<void> {
  bridge.handlerFor(target)(request);
  await new Promise((r) => setImmediate(r));
}

describe("TeamsApprovalBridge", () => {
  it("posts an Adaptive Card with Approve and Deny carrying the approval id", async () => {
    const { bridge, api } = makeBridge();
    await posted(bridge);
    const activity = (api.sendActivity.mock.calls[0] as unknown[])[1] as {
      attachments: Array<{ contentType: string; content: { actions: Array<{ title: string; data: unknown }> } }>;
    };
    expect(activity.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(activity.attachments[0]?.content.actions.map((a) => a.data)).toEqual([
      { atomicApproval: "appr-1", verdict: "yes" },
      { atomicApproval: "appr-1", verdict: "no" },
    ]);
  });

  it("settles on an owner's click and replaces the card", async () => {
    const { bridge, api, resolve } = makeBridge();
    await posted(bridge);
    const reply = await bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "yes" }, OWNER, CONV);
    expect(reply).toBe("Approved.");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "appr-1", approved: true }));
    expect(api.updateActivity).toHaveBeenCalledWith(target, "card-1", expect.objectContaining({ type: "message" }));
  });

  it("refuses a click from a non-owner and leaves the request open", async () => {
    const { bridge, resolve } = makeBridge();
    await posted(bridge);
    expect(await bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "yes" }, "aad-stranger", CONV)).toBe("");
    expect(resolve).not.toHaveBeenCalled();
    expect(bridge.pendingIn(CONV)).toBe(1);
  });

  it("refuses a click from another conversation", async () => {
    const { bridge, resolve } = makeBridge();
    await posted(bridge);
    await bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "yes" }, OWNER, "19:other@thread.tacv2");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not save an always rule the card never offered", async () => {
    const { bridge, resolve } = makeBridge({ canGrantAlways: false });
    await posted(bridge);
    expect(await bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "always" }, OWNER, CONV)).toMatch(/not offered/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts a typed yes <code> from an owner, ignores it from anyone else", async () => {
    const { bridge, resolve } = makeBridge();
    await posted(bridge);
    expect(await bridge.tryAnswer(CONV, "aad-stranger", "yes abc123")).toBeNull();
    expect(await bridge.tryAnswer(CONV, OWNER, "no abc123")).toBe("Denied.");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
  });

  it("treats a bare yes with nothing open as an ordinary message", async () => {
    const { bridge } = makeBridge();
    expect(await bridge.tryAnswer(CONV, OWNER, "yes")).toBeNull();
  });

  it("ignores values that are not its own", async () => {
    const { bridge } = makeBridge();
    expect(await bridge.handleSubmit({ other: 1 }, OWNER, CONV)).toBeNull();
  });

  it("offers Allow always only when the gate can save it", () => {
    expect((approvalCard(request, "h", "abc123", "always allow shell") as { actions: unknown[] }).actions).toHaveLength(3);
    expect(conversationRoot(CONV)).toBe("19:abc@thread.tacv2");
  });
});
