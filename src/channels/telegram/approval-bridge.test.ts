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

interface ScheduledEntry {
  fire: () => void;
  ms: number;
  cancelled: boolean;
}

interface TestHarness {
  bridge: ApprovalBridge;
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
  approvals: {
    resolve: ReturnType<typeof vi.fn>;
    decisions: ApprovalDecision[];
  };
  scheduled: ScheduledEntry[];
  fireFirst: () => void;
}

function makeHarness(
  overrides: Partial<ApprovalBridgeDeps> = {},
): TestHarness {
  const decisions: ApprovalDecision[] = [];
  const resolve = vi.fn((decision: ApprovalDecision) => {
    decisions.push(decision);
    return true;
  });
  const sendMessage = vi.fn(async () => ({ message_id: 99 }));
  const editMessageText = vi.fn(async () => undefined);
  const answerCallbackQuery = vi.fn(async () => undefined);
  const scheduled: ScheduledEntry[] = [];
  const schedule = (cb: () => void, ms: number): (() => void) => {
    const entry: ScheduledEntry = { fire: cb, ms, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const bridge = new ApprovalBridge({
    api: {
      sendMessage,
      editMessageText,
      answerCallbackQuery,
    },
    approvals: { resolve },
    ownerUserId: 42,
    logger: new StructuredLogger({ level: "warn", sinks: [] }),
    schedule,
    timeoutMs: 1000,
    ...overrides,
  });
  return {
    bridge,
    api: { sendMessage, editMessageText, answerCallbackQuery },
    approvals: { resolve, decisions },
    scheduled,
    fireFirst: () => {
      const next = scheduled.find((e) => !e.cancelled);
      if (!next) throw new Error("no scheduled fire available");
      next.cancelled = true;
      next.fire();
    },
  };
}

function req(approvalId = "abc"): ApprovalRequest {
  return {
    approvalId,
    sessionId: "s-1",
    tool: "os.shell.run",
    category: "shell",
    reason: "skill needs to run \"git push\"",
    preview: "git push origin main",
  };
}

type Keyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

/** The `reply_markup` of the Nth `sendMessage` call (default: the first). */
function keyboardOf(
  sendMessage: ReturnType<typeof vi.fn>,
  call = 0,
): Keyboard {
  const opts = sendMessage.mock.calls[call]![2] as { reply_markup: Keyboard };
  return opts.reply_markup;
}

function callback(
  approvalId: string,
  kind: "y" | "n" | "s" | "a",
  fromId: number = 42,
): InboundCallbackUpdate {
  return {
    id: "cb-1",
    from: { id: fromId },
    message: { chat: { id: 7 }, message_id: 99 },
    data: `appr:${approvalId}:${kind}`,
  };
}

describe("ApprovalBridge.dispatch", () => {
  it("sends inline keyboard with grant buttons when applicable", async () => {
    const h = makeHarness();
    const r = req("abc");
    r.commandShape = "git";
    await h.bridge.dispatch(r, 7);

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    // Exact match, not `toContain`: the row order and every
    // `callback_data` are part of the wire contract. A shape row that
    // emitted `:s` would grant the whole category instead of the one
    // binary the operator agreed to.
    expect(keyboardOf(h.api.sendMessage)).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: "appr:abc:y" },
          { text: "❌ Deny", callback_data: "appr:abc:n" },
        ],
        [
          { text: "🔓 Grant category for session", callback_data: "appr:abc:s" },
        ],
        [
          { text: `🔓 Grant "git" for session`, callback_data: "appr:abc:a" },
        ],
      ],
    });
  });

  it("omits grant buttons when not applicable (trust_config)", async () => {
    const h = makeHarness();
    const r = req("abc");
    // trust_config is the only non-grantable category — no s or a buttons
    r.category = "trust_config";
    await h.bridge.dispatch(r, 7);

    const buttons = keyboardOf(h.api.sendMessage).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["✅ Approve", "❌ Deny"]);
  });

  it("bounds the button label when the command shape is oversize", async () => {
    const h = makeHarness();
    const r = req("abc");
    r.commandShape = "x".repeat(80);
    await h.bridge.dispatch(r, 7);

    const shapeRow = keyboardOf(h.api.sendMessage).inline_keyboard.at(-1)!;
    expect(shapeRow[0]!.text).toBe(`🔓 Grant "${"x".repeat(31)}…" for session`);
    expect(shapeRow[0]!.callback_data).toBe("appr:abc:a");
  });

  it("sends an inline keyboard with approve, deny, and grant buttons", async () => {
    const h = makeHarness();
    const r = req("abc");
    await h.bridge.dispatch(r, 7);

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = h.api.sendMessage.mock.calls[0]!;
    expect(args[0]).toBe(7);
    const text = args[1] as string;
    expect(text).toContain("Approval requested");
    expect(text).toContain("os.shell.run");
    expect(text).toContain("kind: shell command");
    expect(text).toContain("git push");
    // Shell requests get approve/deny + grant-category row (no shape button without commandShape)
    expect(keyboardOf(h.api.sendMessage)).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: "appr:abc:y" },
          { text: "❌ Deny", callback_data: "appr:abc:n" },
        ],
        [
          { text: "🔓 Grant category for session", callback_data: "appr:abc:s" },
        ],
      ],
    });
    expect(h.bridge.pendingCount()).toBe(1);
  });

  it("auto-denies immediately when sendMessage rejects", async () => {
    const h = makeHarness();
    h.api.sendMessage.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    await h.bridge.dispatch(req("abc"), 7);

    expect(h.approvals.decisions).toEqual([
      {
        approvalId: "abc",
        approved: false,
        reason: "telegram delivery failed",
      },
    ]);
    expect(h.bridge.pendingCount()).toBe(0);
    expect(h.scheduled).toHaveLength(0);
  });

  it("auto-denies when sendMessage returns no message_id", async () => {
    const h = makeHarness();
    h.api.sendMessage.mockImplementationOnce(async () => ({}));

    await h.bridge.dispatch(req("abc"), 7);

    expect(h.approvals.decisions).toEqual([
      {
        approvalId: "abc",
        approved: false,
        reason: "telegram delivery failed",
      },
    ]);
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it("warns and drops a duplicate dispatch on the same approvalId", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);
    await h.bridge.dispatch(req("abc"), 7);

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.bridge.pendingCount()).toBe(1);
  });
});

describe("ApprovalBridge.handleCallback", () => {
  it("approves on `y`, resolves the gate, edits the message", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback(callback("abc", "y"));

    expect(h.approvals.decisions).toEqual([
      { approvalId: "abc", approved: true, reason: "telegram" },
    ]);
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Approved",
    });
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText.mock.calls[0]![2]).toBe("✅ approved");
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it("denies on `n`, resolves the gate, edits the message", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback(callback("abc", "n"));

    expect(h.approvals.decisions).toEqual([
      { approvalId: "abc", approved: false, reason: "telegram" },
    ]);
    expect(h.api.editMessageText.mock.calls[0]![2]).toBe("❌ denied");
  });

  it("drops a non-owner callback silently — no resolve, no edit, no ack", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback(callback("abc", "y", 999));

    expect(h.approvals.decisions).toEqual([]);
    expect(h.api.editMessageText).not.toHaveBeenCalled();
    expect(h.api.answerCallbackQuery).not.toHaveBeenCalled();
    expect(h.bridge.pendingCount()).toBe(1);
  });

  it("drops every callback when ownerUserId is null", async () => {
    const h = makeHarness({ ownerUserId: null });
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback(callback("abc", "y"));

    expect(h.approvals.decisions).toEqual([]);
    expect(h.bridge.pendingCount()).toBe(1);
  });

  it("drops a malformed callback (wrong prefix)", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback({
      id: "cb-1",
      from: { id: 42 },
      data: "other:foo:bar",
    });

    expect(h.approvals.decisions).toEqual([]);
  });

  it("grants category on `s` callback", async () => {
    const h = makeHarness();
    const r = req("abc");
    r.commandShape = "git";
    await h.bridge.dispatch(r, 7);

    await h.bridge.handleCallback(callback("abc", "s"));

    expect(h.approvals.decisions).toEqual([
      { approvalId: "abc", approved: true, grant: "category", reason: "telegram" },
    ]);
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Approved (shell command granted for session)",
    });
  });

  it("grants shape on `a` callback", async () => {
    const h = makeHarness();
    const r = req("abc");
    r.commandShape = "git";
    await h.bridge.dispatch(r, 7);

    await h.bridge.handleCallback(callback("abc", "a"));

    expect(h.approvals.decisions).toEqual([
      { approvalId: "abc", approved: true, grant: "shape", reason: "telegram" },
    ]);
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: `Approved ("git" granted for session)`,
    });
  });

  it("drops a malformed callback (wrong kind)", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    await h.bridge.handleCallback({
      id: "cb-1",
      from: { id: 42 },
      data: "appr:abc:maybe",
    });

    expect(h.approvals.decisions).toEqual([]);
  });

  it("acknowledges a stale callback without re-resolving", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);
    h.fireFirst(); // simulate timeout firing first

    h.approvals.decisions.length = 0; // clear the timeout decision
    await h.bridge.handleCallback(callback("abc", "y"));

    expect(h.approvals.decisions).toEqual([]); // no new resolve
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Already resolved",
    });
  });

  it("cancels the timer once the button is clicked", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.cancelled).toBe(false);

    await h.bridge.handleCallback(callback("abc", "y"));

    expect(h.scheduled[0]!.cancelled).toBe(true);
  });
});

describe("ApprovalBridge grants against a real ApprovalGate", () => {
  /**
   * Bridge wired to a real `ApprovalGate` instead of the recording stub.
   * The stub accepts whatever decision it is handed, so it cannot show
   * whether the toast agrees with the trust state the operator actually
   * has; only the real gate can.
   */
  function gateHarness(params: Omit<ApprovalRequest, "approvalId">): {
    h: TestHarness;
    gate: ApprovalGate;
    decision: Promise<ApprovalDecision>;
    request: ApprovalRequest;
  } {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = makeHarness({ approvals: gate });
    const decision = gate.request(params);
    return { h, gate, decision, request: emitted[0]! };
  }

  it("approves without claiming a category grant the gate refuses", async () => {
    const { h, gate, decision, request } = gateHarness({
      sessionId: "s-1",
      tool: "trust.config.write",
      category: "trust_config",
      reason: "raise the standing approval level",
    });
    await h.bridge.dispatch(request, 7);

    // Forged payload: the keyboard never offers `:s` for trust_config.
    await h.bridge.handleCallback(callback(request.approvalId, "s"));

    expect((await decision).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: [] });
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Approved",
    });
  });

  it("approves without claiming a shape grant when the request has no command shape", async () => {
    const { h, gate, decision, request } = gateHarness({
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell",
      reason: "opaque command, no shape to grant",
      preview: "bash -c 'echo hi'",
    });
    await h.bridge.dispatch(request, 7);

    await h.bridge.handleCallback(callback(request.approvalId, "a"));

    expect((await decision).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({ categories: [], shapes: [] });
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Approved",
    });
  });

  it("records the grant the gate accepts and names it in the toast", async () => {
    const { h, gate, decision, request } = gateHarness({
      sessionId: "s-1",
      tool: "os.shell.run",
      category: "shell",
      reason: "skill needs to run \"git push\"",
      commandShape: "git",
    });
    await h.bridge.dispatch(request, 7);

    await h.bridge.handleCallback(callback(request.approvalId, "a"));

    expect((await decision).approved).toBe(true);
    expect(gate.sessionGrants("s-1")).toEqual({
      categories: [],
      shapes: ["git"],
    });
    expect(h.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: `Approved ("git" granted for session)`,
    });
  });
});

describe("ApprovalBridge timeout", () => {
  it("auto-denies after timeoutMs and edits the message", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    h.fireFirst();

    expect(h.approvals.decisions).toEqual([
      { approvalId: "abc", approved: false, reason: "timeout" },
    ]);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText.mock.calls[0]![2]).toBe(
      "⏱ timed out — auto-denied",
    );
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it("does not edit the message when the gate has already been resolved elsewhere", async () => {
    const h = makeHarness();
    h.approvals.resolve.mockReturnValueOnce(false); // simulate already-resolved
    await h.bridge.dispatch(req("abc"), 7);

    h.fireFirst();

    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });
});

describe("ApprovalBridge.cancelAll", () => {
  it("cancels every pending timer and forgets state without resolving", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("a-1"), 7);
    await h.bridge.dispatch(req("a-2"), 8);
    expect(h.bridge.pendingCount()).toBe(2);

    h.bridge.cancelAll();

    expect(h.bridge.pendingCount()).toBe(0);
    expect(h.scheduled.every((e) => e.cancelled)).toBe(true);
    expect(h.approvals.decisions).toEqual([]);
  });
});
