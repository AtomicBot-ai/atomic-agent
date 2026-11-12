import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { ACTION_ID_PREFIX, SlackApprovalBridge, approvalBlocks } from "./slack-approval-bridge.js";

const OWNER = "UOWNER";

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "ap-1",
    sessionId: "s1",
    tool: "os.shell.exec",
    category: "shell",
    reason: "runs a command",
    preview: "rm -rf build <x>",
    ...over,
  } as ApprovalRequest;
}

function makeBridge(resolveResult = true, canGrantAlways = false) {
  const api = {
    postMessage: vi.fn(async () => "100.1"),
    updateMessage: vi.fn(async () => {}),
    postEphemeral: vi.fn(async () => {}),
  };
  const approvals = {
    resolve: vi.fn(() => resolveResult),
    canGrantAlways: vi.fn(() => canGrantAlways),
  };
  const bridge = new SlackApprovalBridge({
    api,
    approvals: approvals as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: () => [OWNER],
  });
  return { bridge, api, approvals };
}

function click(verb: string, user = OWNER) {
  return {
    type: "block_actions",
    user: { id: user },
    container: { channel_id: "C1", message_ts: "100.1", thread_ts: "99.0" },
    actions: [{ action_id: `${ACTION_ID_PREFIX}${verb}:ap-1`, value: "ap-1" }],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SlackApprovalBridge", () => {
  it("posts the prompt with buttons in the requesting thread", async () => {
    const { bridge, api } = makeBridge();
    bridge.handlerFor({ channel: "C1", threadTs: "99.0" })(request());
    await flush();
    const [target, , blocks] = api.postMessage.mock.calls[0] as unknown as [unknown, string, Array<Record<string, unknown>>];
    expect(target).toEqual({ channel: "C1", threadTs: "99.0" });
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ action_id: string }> };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      `${ACTION_ID_PREFIX}yes:ap-1`,
      `${ACTION_ID_PREFIX}no:ap-1`,
    ]);
  });

  it("an owner's Approve resolves the gate and rewrites the prompt", async () => {
    const { bridge, api, approvals } = makeBridge();
    bridge.handlerFor({ channel: "C1", threadTs: "99.0" })(request());
    await flush();
    await expect(bridge.handleBlockActions(click("yes"))).resolves.toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "ap-1", approved: true }),
    );
    const [channel, ts, text, blocks] = api.updateMessage.mock.calls[0] as unknown as [string, string, string, unknown[]];
    expect([channel, ts]).toEqual(["C1", "100.1"]);
    expect(text).toMatch(/Approved by <@UOWNER>/);
    // The buttons are gone: only a section block remains.
    expect(blocks).toHaveLength(1);
  });

  it("Deny resolves as not approved", async () => {
    const { bridge, approvals, api } = makeBridge();
    await bridge.handleBlockActions(click("no"));
    expect(approvals.resolve).toHaveBeenCalledWith({ approvalId: "ap-1", approved: false });
    expect(api.updateMessage.mock.calls[0]?.[2]).toMatch(/Denied/);
  });

  it("a non-owner click decides nothing and gets an ephemeral refusal", async () => {
    const { bridge, approvals, api } = makeBridge();
    await expect(bridge.handleBlockActions(click("yes", "USTRANGER"))).resolves.toBe(true);
    expect(approvals.resolve).not.toHaveBeenCalled();
    expect(api.postEphemeral).toHaveBeenCalledWith(
      { channel: "C1", threadTs: "99.0" },
      "USTRANGER",
      expect.stringMatching(/Only a paired operator/),
    );
    expect(api.updateMessage).not.toHaveBeenCalled();
  });

  it("a forged 'always' on a prompt that never offered it saves nothing", async () => {
    const { bridge, approvals, api } = makeBridge();
    await bridge.handleBlockActions(click("always"));
    expect(approvals.resolve).not.toHaveBeenCalled();
    expect(api.updateMessage.mock.calls[0]?.[2]).toMatch(/already expired/);
  });

  it("says so when the gate already settled", async () => {
    const { bridge, api } = makeBridge(false);
    await bridge.handleBlockActions(click("yes"));
    expect(api.updateMessage.mock.calls[0]?.[2]).toMatch(/already expired/);
  });

  it("ignores clicks on buttons it does not own", async () => {
    const { bridge, approvals } = makeBridge();
    const handled = await bridge.handleBlockActions({
      type: "block_actions",
      user: { id: OWNER },
      actions: [{ action_id: "other_app:yes" }],
    });
    expect(handled).toBe(false);
    expect(approvals.resolve).not.toHaveBeenCalled();
  });
});

describe("approvalBlocks", () => {
  it("escapes the preview and fences it", () => {
    const blocks = approvalBlocks(request(), "Approval needed");
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain("rm -rf build &lt;x&gt;");
    expect(text).toContain("```");
  });

  it("adds Allow always only when a label is given", () => {
    const blocks = approvalBlocks(request(), "h", "always allow rm");
    const actions = blocks[1] as { elements: Array<{ action_id: string }> };
    expect(actions.elements.at(-1)?.action_id).toBe(`${ACTION_ID_PREFIX}always:ap-1`);
  });
});
