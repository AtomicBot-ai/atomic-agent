import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { MatrixApprovalBridge, formatMatrixPrompt } from "./matrix-approval-bridge.js";

const OWNER = "@ada:x";
const ROOM = "!r:x";

function request(id = "ap-1"): ApprovalRequest {
  return {
    approvalId: id,
    sessionId: "s1",
    tool: "os.shell.run",
    category: "shell",
    reason: "runs a command",
    preview: "rm -rf build",
  } as ApprovalRequest;
}

function makeBridge(codes = ["abc123", "def456"], canAlways = false) {
  const sent: Array<{ roomId: string; text: string }> = [];
  const resolve = vi.fn(() => true);
  const bridge = new MatrixApprovalBridge({
    api: {
      sendNotice: vi.fn(async (roomId: string, text: string) => {
        sent.push({ roomId, text });
        return "$e";
      }),
    },
    approvals: { resolve, canGrantAlways: () => canAlways },
    logger: { warn: vi.fn() },
    ownerIds: () => [OWNER],
    makeCode: () => codes.shift() ?? "ffffff",
  });
  return { bridge, sent, resolve };
}

async function post(bridge: MatrixApprovalBridge, req: ApprovalRequest, roomId = ROOM) {
  bridge.handlerFor(roomId)(req);
  await new Promise((r) => setImmediate(r));
}

describe("MatrixApprovalBridge", () => {
  it("posts a prompt with a code and approves on 'yes <code>'", async () => {
    const { bridge, sent, resolve } = makeBridge();
    await post(bridge, request());
    expect(sent[0]?.roomId).toBe(ROOM);
    expect(sent[0]?.text).toContain('"yes abc123"');
    expect(bridge.tryAnswer(ROOM, OWNER, "yes abc123")).toBe("Approved.");
    expect(resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Matrix",
    });
    expect(bridge.pendingIn(ROOM)).toBe(0);
  });

  it("denies on 'no <code>' without a reason", async () => {
    const { bridge, resolve } = makeBridge();
    await post(bridge, request());
    expect(bridge.tryAnswer(ROOM, OWNER, "No ABC123")).toBe("Denied.");
    expect(resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: false });
  });

  it("accepts a bare yes only when exactly one prompt is open in the room", async () => {
    const { bridge, resolve } = makeBridge();
    expect(bridge.tryAnswer(ROOM, OWNER, "yes")).toBeNull();
    await post(bridge, request("ap-1"));
    await post(bridge, request("ap-2"));
    expect(bridge.tryAnswer(ROOM, OWNER, "yes")).toMatch(/2 approvals are open/);
    expect(resolve).not.toHaveBeenCalled();
    expect(bridge.tryAnswer(ROOM, OWNER, "yes def456")).toBe("Approved.");
    expect(bridge.tryAnswer(ROOM, OWNER, "y")).toBe("Approved.");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("ignores non-owners and answers from another room", async () => {
    const { bridge, resolve } = makeBridge();
    await post(bridge, request());
    expect(bridge.tryAnswer(ROOM, "@mallory:x", "yes abc123")).toBeNull();
    expect(bridge.tryAnswer("!other:x", OWNER, "yes abc123")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("treats ordinary sentences as messages", async () => {
    const { bridge } = makeBridge();
    await post(bridge, request());
    expect(bridge.tryAnswer(ROOM, OWNER, "yes, and also list the files")).toBeNull();
    expect(bridge.tryAnswer(ROOM, OWNER, "no thanks")).toBeNull();
  });

  it("offers and honours 'always' only when the gate allows it", async () => {
    const plain = makeBridge();
    await post(plain.bridge, request());
    expect(plain.bridge.tryAnswer(ROOM, OWNER, "always abc123")).toMatch(/not offered/);
    expect(plain.resolve).not.toHaveBeenCalled();

    const withAlways = makeBridge(["abc123"], true);
    await post(withAlways.bridge, request());
    expect(withAlways.sent[0]?.text).toContain('"always abc123"');
    expect(withAlways.bridge.tryAnswer(ROOM, OWNER, "always abc123")).toMatch(/^Approved\. Saved:/);
    expect(withAlways.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, grant: "always" }),
    );
  });

  it("says so when the gate already settled", async () => {
    const { bridge, resolve } = makeBridge();
    resolve.mockReturnValue(false);
    await post(bridge, request());
    expect(bridge.tryAnswer(ROOM, OWNER, "yes abc123")).toMatch(/already expired/);
  });
});

describe("formatMatrixPrompt", () => {
  it("names the tool, shows the preview and the answer syntax", () => {
    const text = formatMatrixPrompt(request(), "abc123");
    expect(text).toContain("os.shell.run (shell)");
    expect(text).toContain("rm -rf build");
    expect(text).toContain('"no abc123"');
  });
});
