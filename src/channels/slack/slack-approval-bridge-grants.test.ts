import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/index.js";
import { ApprovalGate } from "../../approval/index.js";

import { ACTION_ID_PREFIX, SlackApprovalBridge, approvalBlocks } from "./slack-approval-bridge.js";

// "Allow ... this session" buttons on the Slack approval prompt
// (ATO-2509): the same grants and labels Telegram offers (GitHub #230),
// through the same `ApprovalGate.resolve`.

const OWNER = "UOWNER";
const TARGET = { channel: "C1", threadTs: "99.0" };

function shellReq(approvalId = "ap-1", commandShape?: string): ApprovalRequest {
  return {
    approvalId,
    sessionId: "s-1",
    tool: "os.shell.run",
    category: "shell",
    reason: "run git",
    preview: "git push origin main",
    ...(commandShape !== undefined ? { commandShape } : {}),
  };
}

function harness(approvals?: ApprovalGate) {
  const api = {
    postMessage: vi.fn(async () => "100.1"),
    updateMessage: vi.fn(async (_channel: string, _ts: string, _text: string, _blocks?: readonly unknown[]) => {}),
    postEphemeral: vi.fn(async () => {}),
  };
  const resolve = vi.fn(() => true);
  const bridge = new SlackApprovalBridge({
    api,
    approvals: approvals ?? { resolve },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: () => [OWNER],
  });
  const buttons = () => {
    const blocks = (api.postMessage.mock.calls[0] as unknown[])[2] as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string; text: { text: string } }>;
    };
    return actions.elements.map((e) => [e.text.text, e.action_id]);
  };
  return { bridge, api, resolve, buttons };
}

function click(verb: string, approvalId = "ap-1") {
  return {
    type: "block_actions",
    user: { id: OWNER },
    container: { channel_id: "C1", message_ts: "100.1", thread_ts: "99.0" },
    actions: [{ action_id: `${ACTION_ID_PREFIX}${verb}:${approvalId}`, value: approvalId }],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Slack session grant buttons (ATO-2509)", () => {
  it("offers the kind and the command shape with Telegram's labels", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)(shellReq("ap-1", "git"));
    await flush();
    expect(h.buttons()).toEqual([
      ["Approve", `${ACTION_ID_PREFIX}yes:ap-1`],
      ["Deny", `${ACTION_ID_PREFIX}no:ap-1`],
      ["Allow shell command this session", `${ACTION_ID_PREFIX}session:ap-1`],
      ["Allow all git this session", `${ACTION_ID_PREFIX}shape:ap-1`],
    ]);
  });

  it("puts Allow always after the grants", () => {
    const offer = { category: "shell command", shell: true };
    const blocks = approvalBlocks(shellReq(), "h", "always allow git", offer);
    const actions = blocks[1] as { elements: Array<{ action_id: string }> };
    expect(actions.elements.map((e) => e.action_id.split(":")[1])).toEqual(["yes", "no", "session", "always"]);
  });

  it("offers no grant for a category that is never granted, and a forged click settles nothing", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)({ ...shellReq("tc"), tool: "trust.config.write", category: "trust_config" });
    await flush();
    expect(h.buttons().map(([, id]) => id)).toEqual([`${ACTION_ID_PREFIX}yes:tc`, `${ACTION_ID_PREFIX}no:tc`]);
    await h.bridge.handleBlockActions(click("session", "tc"));
    await h.bridge.handleBlockActions(click("shape", "tc"));
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("drops a shape click when no shape was offered", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)(shellReq("op"));
    await flush();
    await h.bridge.handleBlockActions(click("shape", "op"));
    expect(h.resolve).not.toHaveBeenCalled();
    // The prompt is still open: its message and buttons stay (ATO-2778).
    expect(h.api.updateMessage).not.toHaveBeenCalled();
  });

  it("resolves the kind click as an approval with a category grant and says what was allowed", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)(shellReq("ap-1", "git"));
    await flush();
    await expect(h.bridge.handleBlockActions(click("session"))).resolves.toBe(true);
    expect(h.resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Slack",
      grant: "category",
    });
    expect(h.api.updateMessage.mock.calls[0]?.[2]).toBe(
      "Approval needed: `os.shell.run` (shell): Approved by <@UOWNER> for this session: shell command (risky commands still ask).",
    );
  });

  it("resolves the shape click with a shape grant", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)(shellReq("ap-1", "git"));
    await flush();
    await h.bridge.handleBlockActions(click("shape"));
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true, grant: "shape" }));
    expect(h.api.updateMessage.mock.calls[0]?.[2]).toMatch(/for this session: all git commands/);
  });

  it("leaves Approve and Deny as one-off answers", async () => {
    const h = harness();
    h.bridge.handlerFor(TARGET)(shellReq("ap-1", "git"));
    await flush();
    await h.bridge.handleBlockActions(click("yes"));
    expect(h.resolve).toHaveBeenLastCalledWith({ approvalId: "ap-1", approved: true, reason: "approved from Slack" });
    await h.bridge.handleBlockActions(click("no", "ap-2"));
    expect(h.resolve).toHaveBeenLastCalledWith({ approvalId: "ap-2", approved: false });
  });
});

describe("Slack session grants against a real ApprovalGate", () => {
  it("a shape grant makes the next command of that shape run without asking", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = harness(gate);
    const params = {
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell" as const,
      reason: "run git",
      preview: "git status",
      commandShape: "git",
    };
    const first = gate.request(params);
    h.bridge.handlerFor(TARGET)(emitted[0]!);
    await flush();
    await h.bridge.handleBlockActions(click("shape", emitted[0]!.approvalId));

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: ["git"] });
    const second = gate.request({ ...params, preview: "git diff" });
    expect(emitted).toHaveLength(1);
    expect((await second).approved).toBe(true);
  });
});
