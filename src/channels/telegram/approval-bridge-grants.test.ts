import { describe, expect, it, vi } from "vitest";

import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../approval/index.js";
import { ApprovalGate } from "../../approval/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import {
  ApprovalBridge,
  type ApprovalBridgeDeps,
  type InboundCallbackUpdate,
} from "./approval-bridge.js";

// Session grant buttons on the Telegram approval prompt (GitHub #230):
// the same `[s]` / `[a]` the TUI offers, through the same gate.

type Keyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

function harness(overrides: Partial<ApprovalBridgeDeps> = {}) {
  const decisions: ApprovalDecision[] = [];
  const resolve = vi.fn((decision: ApprovalDecision) => {
    decisions.push(decision);
    return true;
  });
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 99 })),
    editMessageText: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
  const bridge = new ApprovalBridge({
    api,
    approvals: { resolve },
    ownerUserId: 42,
    logger: new StructuredLogger({ level: "warn", sinks: [] }),
    schedule: () => () => undefined,
    timeoutMs: 1000,
    ...overrides,
  });
  const keyboard = (): Keyboard =>
    (api.sendMessage.mock.calls[0]![2] as { reply_markup: Keyboard }).reply_markup;
  return { bridge, api, decisions, keyboard };
}

function shellReq(approvalId = "abc", commandShape?: string): ApprovalRequest {
  return {
    approvalId,
    sessionId: "s-1",
    tool: "os.shell.run",
    category: "shell",
    reason: 'skill needs to run "git push"',
    preview: "git push origin main",
    ...(commandShape !== undefined ? { commandShape } : {}),
  };
}

function click(approvalId: string, kind: string): InboundCallbackUpdate {
  return {
    id: "cb-1",
    from: { id: 42 },
    message: { chat: { id: 7 }, message_id: 99 },
    data: `appr:${approvalId}:${kind}`,
  };
}

describe("Telegram session grant buttons (GitHub #230)", () => {
  it("offers the kind and the command shape for the session, in the TUI's words", async () => {
    const h = harness();
    await h.bridge.dispatch(shellReq("abc", "git"), 7);
    // Exact match: the row order and every callback_data are the wire
    // contract. A shape row that sent `:s` would grant every command.
    expect(h.keyboard()).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: "appr:abc:y" },
          { text: "❌ Deny", callback_data: "appr:abc:n" },
        ],
        [{ text: "Allow shell command this session", callback_data: "appr:abc:s" }],
        [{ text: "Allow all git this session", callback_data: "appr:abc:a" }],
      ],
    });
  });

  it("keeps every callback_data inside Telegram's 64-byte limit for a UUID id", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const h = harness();
    await h.bridge.dispatch(shellReq(id, "x".repeat(200)), 7);
    const buttons = h.keyboard().inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data.slice(-2))).toEqual([":y", ":n", ":s", ":a"]);
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
      expect(b.text.length).toBeLessThanOrEqual(60);
    }
  });

  it("offers no grant for a category that is never granted, and a forged one is dropped", async () => {
    const h = harness();
    await h.bridge.dispatch(
      { ...shellReq("tc"), tool: "trust.config.write", category: "trust_config" },
      7,
    );
    expect(h.keyboard().inline_keyboard).toHaveLength(1);
    await h.bridge.handleCallback(click("tc", "s"));
    await h.bridge.handleCallback(click("tc", "a"));
    expect(h.decisions).toEqual([]);
    expect(h.bridge.pendingCount()).toBe(1);
  });

  it("offers no shape grant without a command shape, and drops a forged `a`", async () => {
    const h = harness();
    await h.bridge.dispatch(shellReq("op"), 7);
    expect(h.keyboard().inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "appr:op:y",
      "appr:op:n",
      "appr:op:s",
    ]);
    await h.bridge.handleCallback(click("op", "a"));
    expect(h.decisions).toEqual([]);
    expect(h.bridge.pendingCount()).toBe(1);
  });

  it("resolves `s` as an approval with a category grant and says what was allowed", async () => {
    const h = harness();
    await h.bridge.dispatch(shellReq("abc", "git"), 7);
    await h.bridge.handleCallback(click("abc", "s"));
    expect(h.decisions).toEqual([
      { approvalId: "abc", approved: true, reason: "telegram", grant: "category" },
    ]);
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Approved for this session",
    });
    expect(h.api.editMessageText.mock.calls[0]![2]).toBe(
      "✅ approved · allowed this session: shell command (risky commands still ask)",
    );
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it("resolves `a` as an approval with a shape grant", async () => {
    const h = harness();
    await h.bridge.dispatch(shellReq("abc", "git"), 7);
    await h.bridge.handleCallback(click("abc", "a"));
    expect(h.decisions).toEqual([
      { approvalId: "abc", approved: true, reason: "telegram", grant: "shape" },
    ]);
    expect(h.api.editMessageText.mock.calls[0]![2]).toBe(
      "✅ approved · allowed this session: all git commands (risky commands still ask)",
    );
  });

  it("a grant button on a question is not read as Skip", async () => {
    const h = harness();
    await h.bridge.dispatch(
      {
        ...shellReq("q1"),
        tool: "ask_user",
        category: "user_question",
        question: {
          prompt: "Which one?",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
          allowOther: false,
        },
      } as ApprovalRequest,
      7,
    );
    await h.bridge.handleCallback(click("q1", "s"));
    await h.bridge.handleCallback(click("q1", "a"));
    expect(h.decisions).toEqual([]);
    expect(h.bridge.pendingCount()).toBe(1);
  });
});

describe("Telegram session grants against a real ApprovalGate", () => {
  it("an `a` grant makes the next command of that shape run without asking", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = harness({ approvals: gate });
    const params = {
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell" as const,
      reason: "run git",
      preview: "git status",
      commandShape: "git",
    };
    const first = gate.request(params);
    await h.bridge.dispatch(emitted[0]!, 7);
    await h.bridge.handleCallback(click(emitted[0]!.approvalId, "a"));

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: ["git"] });

    // Checked before awaiting: a second prompt would never be answered.
    const second = gate.request({ ...params, preview: "git diff" });
    expect(emitted).toHaveLength(1);
    expect((await second).approved).toBe(true);
  });

  it("an `s` grant records the category for that session only", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = harness({ approvals: gate });
    const first = gate.request({
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell",
      reason: "run ls",
      preview: "ls",
      commandShape: "ls",
    });
    await h.bridge.dispatch(emitted[0]!, 7);
    await h.bridge.handleCallback(click(emitted[0]!.approvalId, "s"));

    expect((await first).approved).toBe(true);
    expect(gate.sessionGrants("s-1").categories).toEqual(["shell"]);
    expect(gate.sessionGrants("s-2").categories).toEqual([]);
  });
});
