import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSessionMap } from "../chat-session-map.js";
import { ImessageApprovalBridge } from "./imessage-approval-bridge.js";
import { normalizeOwnerIds } from "./imessage-handle.js";
import { handleImessageMessage, type ImessageInboundContext } from "./imessage-inbound-handler.js";
import type { ImsgMessage } from "./imsg-event.js";
import type { ImessageTarget } from "./imsg-send.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-inbound-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "+14155551212";

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return { rowId: 1, chatId: 42, sender: OWNER, isFromMe: false, isGroup: false, text: "hello", attachmentCount: 0, ...over };
}

function setup(over: { allowGroups?: boolean; owners?: string[]; reply?: string } = {}) {
  const sent: Array<{ target: ImessageTarget; text: string }> = [];
  const send = async (target: ImessageTarget, text: string): Promise<void> => {
    sent.push({ target, text });
  };
  const sessions = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  let n = 0;
  const runTurn = vi.fn(async (_session: unknown, _text: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({
      type: "llm_event",
      event: { type: "assistant_reply", text: over.reply ?? "hi from the agent" },
    });
  });
  const runtime = {
    runTurn,
    createSession: (input: { metadata: Record<string, unknown> }) => {
      const s = { id: `s-${++n}`, metadata: input.metadata };
      sessions.set(s.id, s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
  };
  const resolve = vi.fn(() => true);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bridge = new ImessageApprovalBridge({ approvals: { resolve }, logger: logger as never, send, randomCode: () => "1234" });
  const ensure = vi.fn();
  const release = vi.fn();
  const ctx: ImessageInboundContext = {
    runtime: runtime as never,
    logger: logger as never,
    sessions: new ChatSessionMap(join(dir, "imessage-session.json")),
    ownerIds: () => normalizeOwnerIds(over.owners ?? ["+1 (415) 555-1212"]),
    allowGroups: over.allowGroups ?? false,
    bridge,
    inflight: new Map(),
    send,
    ensureApprovalSession: ensure,
    releaseApprovalSession: release,
  };
  return { ctx, sent, runTurn, resolve, bridge, ensure, release, sessions, logger };
}

describe("handleImessageMessage", () => {
  it("runs an owner's text as a turn and replies to their handle", async () => {
    const t = setup();
    await handleImessageMessage(msg(), t.ctx);
    expect(t.runTurn).toHaveBeenCalledTimes(1);
    expect(t.runTurn.mock.calls[0]![1]).toBe("hello");
    expect(t.sent).toEqual([{ target: { kind: "handle", handle: OWNER }, text: "hi from the agent" }]);
    expect(t.ensure).toHaveBeenCalledWith("s-1", 42, { kind: "handle", handle: OWNER });
    // No phone number lands in persisted session metadata.
    expect(JSON.stringify(t.sessions.get("s-1")?.metadata)).not.toContain("415");
  });

  it("keeps one session per chat across messages", async () => {
    const t = setup();
    await handleImessageMessage(msg(), t.ctx);
    await handleImessageMessage(msg({ rowId: 2, text: "again" }), t.ctx);
    expect(t.runTurn.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["s-1", "s-1"]);
  });

  it("ignores its own messages so it never answers itself", async () => {
    const t = setup();
    await handleImessageMessage(msg({ isFromMe: true }), t.ctx);
    expect(t.runTurn).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("drops non-owners, and everyone when no owner is set", async () => {
    const t = setup();
    await handleImessageMessage(msg({ sender: "+15550000000" }), t.ctx);
    const empty = setup({ owners: [] });
    await handleImessageMessage(msg(), empty.ctx);
    expect(t.runTurn).not.toHaveBeenCalled();
    expect(empty.runTurn).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    // The log carries a masked handle, not the number.
    expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain("5550000000");
  });

  it("ignores group chats unless allowGroups, then replies by chat id", async () => {
    const off = setup();
    await handleImessageMessage(msg({ isGroup: true }), off.ctx);
    expect(off.runTurn).not.toHaveBeenCalled();
    const on = setup({ allowGroups: true });
    await handleImessageMessage(msg({ isGroup: true }), on.ctx);
    expect(on.sent[0]?.target).toEqual({ kind: "chat", chatId: 42 });
  });

  it("answers `yes <code>` as an approval, not a turn", async () => {
    const t = setup();
    t.bridge.handlerFor(42, { kind: "handle", handle: OWNER })({ approvalId: "a-1" } as never);
    await handleImessageMessage(msg({ text: "yes 1234" }), t.ctx);
    expect(t.resolve).toHaveBeenCalledWith({ approvalId: "a-1", approved: true, reason: "approved from iMessage" });
    expect(t.runTurn).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.text).toBe("Approved (1234).");
  });

  it("handles /status, /new and /help", async () => {
    const t = setup();
    await handleImessageMessage(msg({ text: "/status" }), t.ctx);
    expect(t.sent.at(-1)?.text).toBe("No session for this chat yet.");
    await handleImessageMessage(msg({ text: "do it" }), t.ctx);
    await handleImessageMessage(msg({ text: "/new" }), t.ctx);
    expect(t.sent.at(-1)?.text).toBe("Started a new session. Previous session s-1 archived.");
    expect(t.release).toHaveBeenCalledWith("s-1");
    await handleImessageMessage(msg({ text: "/HELP" }), t.ctx);
    expect(t.sent.at(-1)?.text).toContain("yes <code>");
  });

  it("tells the owner files are not supported yet", async () => {
    const t = setup();
    await handleImessageMessage(msg({ text: "", attachmentCount: 1 }), t.ctx);
    expect(t.sent.at(-1)?.text).toMatch(/not supported yet/);
    expect(t.runTurn).not.toHaveBeenCalled();
  });

  it("never throws when the runtime does", async () => {
    const t = setup();
    t.runTurn.mockRejectedValueOnce(new Error("provider down for +14155551212"));
    await expect(handleImessageMessage(msg(), t.ctx)).resolves.toBeUndefined();
    expect(t.sent.at(-1)?.text).toBe("Turn failed (provider down for <phone>)");
  });
});
