import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/index.js";
import { ApprovalGate } from "../../approval/index.js";

import { TeamsApprovalBridge, approvalCard } from "./msteams-approval-bridge.js";
import type { TeamsTarget } from "./msteams-types.js";

// "Allow ... this session" actions on the Teams approval card
// (ATO-2509): the same grants and labels Telegram offers (GitHub #230),
// through the same `ApprovalGate.resolve`, with a typed fallback.

const OWNER = "aad-owner";
const CONV = "19:abc@thread.tacv2;messageid=100";
const target: TeamsTarget = { serviceUrl: "https://smba.invalid/", conversationId: CONV, replyToId: "100" };

function shellReq(approvalId = "appr-1", commandShape?: string): ApprovalRequest {
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

type Card = {
  body: Array<{ text: string }>;
  actions: Array<{ title: string; data: { verdict: string } }>;
};

function harness(approvals?: ApprovalGate) {
  const api = {
    sendActivity: vi.fn(async () => "card-1"),
    updateActivity: vi.fn(async () => undefined),
  };
  const resolve = vi.fn(() => true);
  const bridge = new TeamsApprovalBridge({
    api,
    approvals: approvals ?? { resolve },
    logger: { warn: vi.fn() },
    ownerIds: () => [OWNER],
    makeCode: () => "abc123",
  });
  const card = (): Card =>
    ((api.sendActivity.mock.calls[0] as unknown[])[1] as { attachments: Array<{ content: Card }> }).attachments[0]!
      .content;
  return { bridge, api, resolve, card };
}

async function post(bridge: TeamsApprovalBridge, request: ApprovalRequest): Promise<void> {
  bridge.handlerFor(target)(request);
  await new Promise((r) => setImmediate(r));
}

describe("Teams session grant actions (ATO-2509)", () => {
  it("offers the kind and the command shape with Telegram's labels, before Allow always", () => {
    const card = approvalCard(
      shellReq("appr-1", "git"),
      "h",
      "abc123",
      "always allow git",
      { category: "shell command", shape: "git", shell: true },
    ) as Card;
    expect(card.actions.map((a) => [a.title, a.data.verdict])).toEqual([
      ["Approve", "yes"],
      ["Deny", "no"],
      ["Allow shell command this session", "session"],
      ["Allow all git this session", "shape"],
      ["always allow git", "always"],
    ]);
  });

  it("spells out the typed grants in the fallback line", async () => {
    const h = harness();
    await post(h.bridge, shellReq("appr-1", "git"));
    expect(h.card().body.at(-1)?.text).toBe(
      'Or reply "yes abc123" / "no abc123". "session abc123": Allow shell command this session. "all abc123": Allow all git this session.',
    );
  });

  it("offers no grant for a category that is never granted, and a forged one settles nothing", async () => {
    const h = harness();
    await post(h.bridge, { ...shellReq("tc"), tool: "trust.config.write", category: "trust_config" });
    expect(h.card().actions.map((a) => a.data.verdict)).toEqual(["yes", "no"]);
    expect(h.card().body.at(-1)?.text).toBe('Or reply "yes abc123" / "no abc123".');
    expect(await h.bridge.handleSubmit({ atomicApproval: "tc", verdict: "session" }, OWNER, CONV)).toMatch(/not offered/);
    expect(await h.bridge.tryAnswer(CONV, OWNER, "all abc123")).toMatch(/not offered/);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.bridge.pendingIn(CONV)).toBe(1);
  });

  it("resolves the kind click as an approval with a category grant", async () => {
    const h = harness();
    await post(h.bridge, shellReq("appr-1", "git"));
    const reply = await h.bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "session" }, OWNER, CONV);
    expect(reply).toBe("Approved for this session: shell command (risky commands still ask).");
    expect(h.resolve).toHaveBeenCalledWith({
      approvalId: "appr-1",
      approved: true,
      reason: "approved from Microsoft Teams",
      grant: "category",
    });
  });

  it("accepts a typed `all <code>` as the shape grant, but never a bare `all`", async () => {
    const h = harness();
    await post(h.bridge, shellReq("appr-1", "git"));
    expect(await h.bridge.tryAnswer(CONV, OWNER, "all")).toBeNull();
    expect(await h.bridge.tryAnswer(CONV, OWNER, "session")).toBeNull();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(await h.bridge.tryAnswer(CONV, OWNER, "all abc123")).toBe(
      "Approved for this session: all git commands (risky commands still ask).",
    );
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true, grant: "shape" }));
  });

  it("leaves Approve and Deny as one-off answers", async () => {
    const h = harness();
    await post(h.bridge, shellReq("appr-1", "git"));
    expect(await h.bridge.handleSubmit({ atomicApproval: "appr-1", verdict: "no" }, OWNER, CONV)).toBe("Denied.");
    expect(h.resolve).toHaveBeenLastCalledWith({ approvalId: "appr-1", approved: false });
  });
});

describe("Teams session grants against a real ApprovalGate", () => {
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
    await post(h.bridge, emitted[0]!);
    await h.bridge.handleSubmit({ atomicApproval: emitted[0]!.approvalId, verdict: "shape" }, OWNER, CONV);

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: ["git"] });
    const second = gate.request({ ...params, preview: "git diff" });
    expect(emitted).toHaveLength(1);
    expect((await second).approved).toBe(true);
  });
});
