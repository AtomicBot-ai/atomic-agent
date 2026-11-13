import { describe, expect, it, vi } from "vitest";

import {
  DiscordApprovalBridge,
  buttonsFor,
  escapeDiscordText,
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

function makeBridge(owners: readonly string[] = [OWNER]) {
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
    ownerUserIds: () => owners,
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

describe("formatPrompt risk line (ATO-1268)", () => {
  it("shows smart approval's verdict", () => {
    const text = formatPrompt({
      ...REQUEST,
      riskNote: "risk check: medium (installs a package)",
      riskLevel: "medium",
      riskReason: "installs a package",
    });
    expect(text).toContain("Risk check: medium. Installs a package");
    expect(formatPrompt(REQUEST)).not.toContain("Risk check");
  });

  it("escapes markdown and mentions in the model's reason", () => {
    const text = formatPrompt({
      ...REQUEST,
      riskLevel: "high",
      riskReason: "wipes **all** files, tell @everyone",
    });
    expect(text).toContain("Risk check: high. Wipes \\*\\*all\\*\\* files, tell @\u200beveryone");
    expect(text).not.toContain("@everyone");
  });
});

describe("escapeDiscordText", () => {
  it("backslashes markdown characters", () => {
    expect(escapeDiscordText("a_b `c` ||d|| > e")).toBe("a\\_b \\`c\\` \\|\\|d\\|\\| \\> e");
  });
});

describe("buttonsFor", () => {
  it("namespaces the ids so foreign components never match", () => {
    const [row] = buttonsFor("ap-9");
    expect(row?.components[0]?.custom_id).toBe("atomic:approve:yes:ap-9");
    expect(row?.components[1]?.custom_id).toBe("atomic:approve:no:ap-9");
  });
});

describe("Allow always from Discord (ATO-1142)", () => {
  const ALWAYS: ApprovalRequest = {
    ...REQUEST,
    preview: "git status",
    commandShape: "git",
    commandArgv: ["git", "status"],
    workdir: "/work/app",
  };

  function makeAlwaysBridge(canGrantAlways: boolean) {
    const api = {
      sendMessage: vi.fn(async () => "msg-1"),
      updateInteraction: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined),
    };
    const approvals = { resolve: vi.fn(() => true), canGrantAlways: () => canGrantAlways };
    const bridge = new DiscordApprovalBridge({
      api: api as never,
      approvals,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      ownerUserIds: () => [OWNER],
    });
    return { bridge, api, approvals };
  }

  it("adds a third button labelled with the rule when the gate offers it", async () => {
    const { bridge, api } = makeAlwaysBridge(true);
    bridge.handlerFor("c1")(ALWAYS);
    await new Promise((r) => setImmediate(r));
    const rows = (api.sendMessage.mock.calls[0] as unknown[])[2] as ReturnType<typeof buttonsFor>;
    expect(rows[0]?.components[2]).toMatchObject({
      label: 'Always allow "git status" in this project',
      custom_id: "atomic:approve:always:ap-1",
    });
  });

  it("posts only two buttons when it is not offered", async () => {
    const { bridge, api } = makeAlwaysBridge(false);
    bridge.handlerFor("c1")(ALWAYS);
    await new Promise((r) => setImmediate(r));
    const rows = (api.sendMessage.mock.calls[0] as unknown[])[2] as ReturnType<typeof buttonsFor>;
    expect(rows[0]?.components).toHaveLength(2);
  });

  it("resolves the always click as an approval with grant always", async () => {
    const { bridge, approvals } = makeAlwaysBridge(true);
    bridge.handlerFor("c1")(ALWAYS);
    await new Promise((r) => setImmediate(r));
    expect(await bridge.handleInteraction(click("always", OWNER))).toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: true,
      reason: "approved from Discord",
      grant: "always",
    });
  });

  it("ignores an always click for a prompt that never offered it", async () => {
    const { bridge, approvals } = makeAlwaysBridge(false);
    bridge.handlerFor("c1")(ALWAYS);
    await new Promise((r) => setImmediate(r));
    await bridge.handleInteraction(click("always", OWNER));
    expect(approvals.resolve).not.toHaveBeenCalled();
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
    // No reason: the model would read it as the user's own words.
    expect(approvals.resolve).toHaveBeenCalledWith({
      approvalId: "ap-1",
      approved: false,
    });
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
      expect.stringContaining("Only a paired operator"),
    );
  });

  it("ignores every click while unpaired", async () => {
    const { bridge, approvals } = makeBridge([]);
    await bridge.handleInteraction(click("yes", OWNER));
    expect(approvals.resolve).not.toHaveBeenCalled();
  });

  it("lets a second owner answer an approval", async () => {
    // The reason the list exists: an approval must not stall because
    // the account that set the bot up is asleep.
    const { bridge, approvals } = makeBridge([OWNER, "222"]);
    await bridge.handleInteraction(click("yes", "222"));
    expect(approvals.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "ap-1", approved: true }),
    );
  });

  it("still refuses a click from outside the list", async () => {
    const { bridge, approvals } = makeBridge([OWNER, "222"]);
    await bridge.handleInteraction(click("yes", "333"));
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

describe("DiscordApprovalBridge and a dangerous shell command (ATO-1224)", () => {
  const DANGEROUS: ApprovalRequest = {
    ...REQUEST,
    approvalId: "ap-rm",
    category: "shell_dangerous",
    reason: "recursive remove",
    preview: "rm -rf build",
  };

  it("posts approve and deny only, and no click grants anything", async () => {
    const { bridge, api, approvals } = makeBridge();
    bridge.handlerFor("c1")(DANGEROUS);
    await new Promise((r) => setImmediate(r));
    const rows = (api.sendMessage.mock.calls[0] as unknown[])[2] as ReturnType<
      typeof buttonsFor
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.components.map((c) => c.custom_id)).toEqual([
      "atomic:approve:yes:ap-rm",
      "atomic:approve:no:ap-rm",
    ]);

    // A forged grant verb is not a yes.
    await bridge.handleInteraction(click("session", OWNER, "ap-rm"));
    expect(approvals.resolve).toHaveBeenLastCalledWith({
      approvalId: "ap-rm",
      approved: false,
    });
    await bridge.handleInteraction(click("yes", OWNER, "ap-rm"));
    expect(approvals.resolve).toHaveBeenLastCalledWith({
      approvalId: "ap-rm",
      approved: true,
      reason: "approved from Discord",
    });
  });
});
