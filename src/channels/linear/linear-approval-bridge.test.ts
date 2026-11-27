import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { LinearApprovalBridge } from "./linear-approval-bridge.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import type { LinearTarget } from "./linear-types.js";

const request = {
  approvalId: "ap-1",
  sessionId: "s-1",
  tool: "composio.LINEAR_UPDATE_ISSUE",
  category: "network",
  reason: "changes the issue status",
  preview: '{"stateId":"done"}',
} as unknown as ApprovalRequest;

function makeBridge() {
  const posted: Array<{ target: LinearTarget; body: string }> = [];
  const resolve = vi.fn(() => true);
  const bridge = new LinearApprovalBridge({
    post: async (target, body) => {
      posted.push({ target, body });
    },
    approvals: { resolve: resolve as never },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    randomCode: () => "K7Q2",
  });
  return { bridge, posted, resolve };
}

describe("LinearApprovalBridge", () => {
  it("posts the prompt in the issue thread and approves only on yes <code> from that issue", async () => {
    const { bridge, posted, resolve } = makeBridge();
    bridge.handlerFor({ issueId: "issue-7", parentId: "c1" })(request);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.target).toEqual({ issueId: "issue-7", parentId: "c1" });
    expect(posted[0]?.body).toContain("Reply `yes K7Q2` to approve");
    expect(bridge.pendingIn("issue-7")).toBe(1);

    expect(bridge.tryAnswer("issue-9", "yes K7Q2")).toContain("No pending approval");
    expect(resolve).not.toHaveBeenCalled();
    expect(bridge.tryAnswer("issue-7", "looks good")).toBeNull();
    expect(bridge.tryAnswer("issue-7", "yes k7q2")).toBe("Approved.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: true, reason: "approved from Linear" });
    expect(bridge.pendingIn("issue-7")).toBe(0);
  });

  it("denies on no <code>", () => {
    const { bridge, resolve } = makeBridge();
    bridge.handlerFor({ issueId: "issue-7" })(request);
    expect(bridge.tryAnswer("issue-7", "no K7Q2")).toBe("Denied.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: false });
  });
});

describe("LinearOwnComments", () => {
  it("matches by id always, by body only for the key's user and only once", () => {
    const own = new LinearOwnComments();
    own.notePending("  hello  ");
    expect(own.isOwn("c1", "hello", false)).toBe(false);
    expect(own.isOwn("c1", "hello", true)).toBe(true);
    expect(own.isOwn("c2", "hello", true)).toBe(false);
    // The matched echo's id is remembered for a redelivery.
    expect(own.isOwn("c1", "edited", false)).toBe(true);
    own.notePosted("c9");
    expect(own.isOwn("c9", "anything", false)).toBe(true);
  });
});
