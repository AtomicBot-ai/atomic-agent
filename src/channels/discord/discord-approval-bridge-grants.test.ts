import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/index.js";
import { ApprovalGate } from "../../approval/index.js";

import {
  DiscordApprovalBridge,
  buttonsFor,
  type DiscordInteractionEvent,
} from "./discord-approval-bridge.js";

// "Allow ... this session" buttons on the Discord approval prompt
// (ATO-2509): the same grants and labels Telegram offers (GitHub #230),
// through the same `ApprovalGate.resolve`.

const OWNER = "111";

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
    sendMessage: vi.fn(async () => "msg-1"),
    updateInteraction: vi.fn(async () => undefined),
  };
  const resolve = vi.fn(() => true);
  const bridge = new DiscordApprovalBridge({
    api: api as never,
    approvals: approvals ?? { resolve },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerUserIds: () => [OWNER],
  });
  const rows = () =>
    (api.sendMessage.mock.calls[0] as unknown[])[2] as ReturnType<typeof buttonsFor>;
  return { bridge, api, resolve, rows };
}

function click(verb: string, approvalId = "ap-1"): DiscordInteractionEvent {
  return {
    id: "i1",
    token: "itok",
    data: { custom_id: `atomic:approve:${verb}:${approvalId}` },
    user: { id: OWNER },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("Discord session grant buttons (ATO-2509)", () => {
  it("adds a second row with Telegram's grant labels", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")(shellReq("ap-1", "git"));
    await flush();
    const rows = h.rows();
    expect(rows[0]!.components.map((c) => c.custom_id)).toEqual([
      "atomic:approve:yes:ap-1",
      "atomic:approve:no:ap-1",
    ]);
    expect(rows[1]!.components.map((c) => [c.label, c.custom_id])).toEqual([
      ["Allow shell command this session", "atomic:approve:session:ap-1"],
      ["Allow all git this session", "atomic:approve:shape:ap-1"],
    ]);
  });

  it("keeps every custom_id inside Discord's 100-character limit for a UUID id", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const offer = { category: "shell command", shape: "x".repeat(200), shell: true };
    for (const button of buttonsFor(id, "always", offer).flatMap((r) => r.components)) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
      expect(button.label.length).toBeLessThanOrEqual(80);
    }
  });

  it("offers no grant row for a category that is never granted", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")({ ...shellReq("tc"), tool: "trust.config.write", category: "trust_config" });
    await flush();
    expect(h.rows()).toHaveLength(1);
    await h.bridge.handleInteraction(click("session", "tc"));
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("drops a shape click when no shape was offered", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")(shellReq("op"));
    await flush();
    expect(h.rows()[1]!.components.map((c) => c.custom_id)).toEqual(["atomic:approve:session:op"]);
    await h.bridge.handleInteraction(click("shape", "op"));
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.api.updateInteraction).toHaveBeenCalledWith("i1", "itok", expect.stringContaining("already expired"));
  });

  it("resolves the kind click as an approval with a category grant", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")(shellReq("ap-1", "git"));
    await flush();
    expect(await h.bridge.handleInteraction(click("session"))).toBe(true);
    expect(h.resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Discord",
      grant: "category",
    });
    expect(h.api.updateInteraction).toHaveBeenCalledWith(
      "i1",
      "itok",
      "✅ Approved for this session: shell command \\(risky commands still ask\\).",
    );
  });

  it("resolves the shape click with a shape grant", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")(shellReq("ap-1", "git"));
    await flush();
    await h.bridge.handleInteraction(click("shape"));
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true, grant: "shape" }));
  });

  it("leaves Approve and Deny as one-off answers", async () => {
    const h = harness();
    h.bridge.handlerFor("c1")(shellReq("ap-1", "git"));
    await flush();
    await h.bridge.handleInteraction(click("yes"));
    expect(h.resolve).toHaveBeenLastCalledWith({ approvalId: "ap-1", approved: true, reason: "approved from Discord" });
    h.bridge.handlerFor("c1")(shellReq("ap-2", "git"));
    await flush();
    await h.bridge.handleInteraction(click("no", "ap-2"));
    expect(h.resolve).toHaveBeenLastCalledWith({ approvalId: "ap-2", approved: false });
  });
});

describe("Discord session grants against a real ApprovalGate", () => {
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
    h.bridge.handlerFor("c1")(emitted[0]!);
    await flush();
    await h.bridge.handleInteraction(click("shape", emitted[0]!.approvalId));

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: ["git"] });
    const second = gate.request({ ...params, preview: "git diff" });
    expect(emitted).toHaveLength(1);
    expect((await second).approved).toBe(true);
  });

  it("a kind grant records the category for that session only", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = harness(gate);
    const first = gate.request({
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell",
      reason: "run ls",
      preview: "ls",
      commandShape: "ls",
    });
    h.bridge.handlerFor("c1")(emitted[0]!);
    await flush();
    await h.bridge.handleInteraction(click("session", emitted[0]!.approvalId));

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1").categories).toEqual(["shell"]);
    expect(gate.sessionGrants("s-2").categories).toEqual([]);
  });
});
