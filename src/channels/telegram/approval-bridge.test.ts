import { describe, expect, it, vi } from "vitest";

import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../approval/index.js";
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

function callback(
  approvalId: string,
  kind: "y" | "n",
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
  it("sends a 2-button inline keyboard with the right callback_data", async () => {
    const h = makeHarness();
    await h.bridge.dispatch(req("abc"), 7);

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = h.api.sendMessage.mock.calls[0]!;
    expect(args[0]).toBe(7);
    const text = args[1] as string;
    expect(text).toContain("Approval requested");
    expect(text).toContain("os.shell.run");
    // R5: the ladder category is surfaced to the Telegram operator.
    expect(text).toContain("kind: shell command");
    expect(text).toContain("git push");
    const opts = args[2] as { reply_markup: unknown };
    expect(opts.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: "appr:abc:y" },
          { text: "❌ Deny", callback_data: "appr:abc:n" },
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
