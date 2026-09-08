import { describe, expect, it, vi } from "vitest";

import {
  DiscordApprovalBridge,
  buttonsFor,
  formatPrompt,
  type DiscordInteractionEvent,
} from "./discord-approval-bridge.js";
import type { ApprovalRequest } from "../../approval/approval-gate.js";

const OWNER = "111";

const REQUEST: ApprovalRequest = {
  approvalId: "ap-1",
  sessionId: "s1",
  tool: "os.shell.run",
  category: "shell",
  reason: "runs a command",
  preview: "rm -rf build",
};

function makeBridge(owner: string | null = OWNER) {
  const api = {
    sendMessage: vi.fn(async () => "msg-1"),
    updateInteraction: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
  };
  const approvals = { resolve: vi.fn(() => true) };
  const bridge = new DiscordApprovalBridge({
    api: api as never,
    approvals: approvals as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerUserId: () => owner,
  });
  return { bridge, api, approvals };
}

function click(
  verb: string,
  actorId: string,
  approvalId = "ap-1",
): DiscordInteractionEvent {
  return {
    id: "i1",
    token: "itok",
    data: { custom_id: `atomic:approve:${verb}:${approvalId}` },
    user: { id: actorId },
  };
}

describe("formatPrompt", () => {
  it("names the tool, category and reason", () => {
    const text = formatPrompt(REQUEST);
    expect(text).toContain("os.shell.run");
    expect(text).toContain("shell");
    expect(text).toContain("runs a command");
    expect(text).toContain("rm -rf build");
  });

  it("neutralises a fence inside the preview", () => {
    // A command containing ``` would otherwise break out of the code
    // block and let the preview forge the rest of the message.
    const text = formatPrompt({ ...REQUEST, preview: "echo '```'" });
    expect(text.split("```").length - 1).toBe(2);
  });
});

describe("buttonsFor", () => {
  it("namespaces the ids so foreign components never match", () => {
    const [row] = buttonsFor("ap-9");
    expect(row?.components[0]?.custom_id).toBe("atomic:approve:yes:ap-9");
    expect(row?.components[1]?.custom_id).toBe("atomic:approve:no:ap-9");
  });
});

describe("DiscordApprovalBridge", () => {
  it("posts the prompt with buttons into the originating channel", async () => {
    const { bridge, api } = makeBridge();
    bridge.handlerFor("c1")(REQUEST);
    await new Promise((r) => setImmediate(r));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining("os.shell.run"),
      expect.any(Array),
    );
  });

  it("resolves the gate when the owner approves", async () => {
    const { bridge, approvals } = makeBridge();
    await bridge.handleInteraction(click("yes", OWNER));
    expect(approvals.resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Discord",
    });
  });

  it("resolves as denied when the owner denies", async () => {
    const { bridge, approvals } = makeBridge();
    await bridge.handleInteraction(click("no", OWNER));
    expect(approvals.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false }),
    );
  });

  it("ignores a click from anyone but the paired owner", async () => {
    // Anyone in a shared guild can press a button; only the operator
    // may decide whether a destructive tool runs.
    const { bridge, approvals, api } = makeBridge();
    await bridge.handleInteraction(click("yes", "stranger"));
    expect(approvals.resolve).not.toHaveBeenCalled();
    expect(api.updateInteraction).toHaveBeenCalledWith(
      "i1",
      "itok",
      expect.stringContaining("Only the paired operator"),
    );
  });

  it("ignores every click while unpaired", async () => {
    const { bridge, approvals } = makeBridge(null);
    await bridge.handleInteraction(click("yes", OWNER));
    expect(approvals.resolve).not.toHaveBeenCalled();
  });

  it("reads the actor from member.user in a guild interaction", async () => {
    const { bridge, approvals } = makeBridge();
    await bridge.handleInteraction({
      id: "i1",
      token: "t",
      data: { custom_id: "atomic:approve:yes:ap-1" },
      member: { user: { id: OWNER } },
    });
    expect(approvals.resolve).toHaveBeenCalled();
  });

  it("declines interactions that are not its own", async () => {
    const { bridge, approvals } = makeBridge();
    const handled = await bridge.handleInteraction({
      id: "i1",
      token: "t",
      data: { custom_id: "someone-elses-button" },
      user: { id: OWNER },
    });
    expect(handled).toBe(false);
    expect(approvals.resolve).not.toHaveBeenCalled();
  });

  it("says so when the request already settled elsewhere", async () => {
    // A stale button must not imply the click did something.
    const { bridge, approvals, api } = makeBridge();
    approvals.resolve.mockReturnValueOnce(false);
    await bridge.handleInteraction(click("yes", OWNER));
    expect(api.updateInteraction).toHaveBeenCalledWith(
      "i1",
      "itok",
      expect.stringContaining("already expired"),
    );
  });

  it("never approves on its own", async () => {
    // The bridge only relays; nothing here may resolve a request
    // without a button press.
    const { bridge, approvals } = makeBridge();
    bridge.handlerFor("c1")(REQUEST);
    await new Promise((r) => setImmediate(r));
    expect(approvals.resolve).not.toHaveBeenCalled();
  });
});
