import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSessionMap } from "../chat-session-map.js";
import { WhatsAppApprovalBridge } from "./whatsapp-approval-bridge.js";
import { handleWhatsAppMessage, type WhatsAppInboundContext } from "./whatsapp-inbound-handler.js";
import type { RawWhatsAppMessage } from "./whatsapp-types.js";

const OWNER = "15550002222@s.whatsapp.net";
const STRANGER = "19990000000@s.whatsapp.net";
const GROUP = "12036300@g.us";
const dirs: string[] = [];
let counter = 0;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dm(
  text: string,
  from = OWNER,
  over: NonNullable<RawWhatsAppMessage["key"]> = {},
): RawWhatsAppMessage {
  return {
    key: { remoteJid: from, fromMe: false, id: `M${++counter}`, ...over },
    pushName: "Ada",
    message: { conversation: text },
  };
}

function makeCtx(over: Partial<WhatsAppInboundContext> = {}, replyText = "done") {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-inbound-"));
  dirs.push(dir);
  const sent: Array<{ chat: string; text: string }> = [];
  const sessions = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  let n = 0;
  const runTurn = vi.fn(async (_session: unknown, _prompt: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: replyText } });
    return {};
  });
  const runtime = {
    runTurn,
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
    createSession: (input: { metadata: Record<string, unknown> }) => {
      const s = { id: `s-${++n}`, metadata: input.metadata };
      sessions.set(s.id, s);
      return s;
    },
    turnController: { isBusy: () => false },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = async (chat: string, text: string) => {
    sent.push({ chat, text });
  };
  const bridge = new WhatsAppApprovalBridge({
    send,
    approvals: { resolve: vi.fn(() => true) as never },
    logger: logger as never,
    randomCode: () => "K7Q2",
  });
  const ensure = vi.fn();
  const ctx: WhatsAppInboundContext = {
    runtime: runtime as never,
    logger: logger as never,
    sessionMap: new ChatSessionMap(join(dir, "whatsapp-session.json")),
    ownerIds: [OWNER],
    allowGroups: false,
    bridge,
    send,
    inflight: new Map(),
    seen: new Set(),
    ensureApprovalSession: ensure,
    releaseApprovalSession: vi.fn(),
    ...over,
  };
  return { ctx, sent, runTurn, ensure, bridge, logger, dir };
}

describe("handleWhatsAppMessage", () => {
  it("runs an owner DM as a turn with origin whatsapp and replies in that chat", async () => {
    const { ctx, sent, runTurn, ensure } = makeCtx();
    await handleWhatsAppMessage(dm("what time is it"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toBe("what time is it");
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "whatsapp" });
    expect(runTurn.mock.calls[0]?.[2]).not.toHaveProperty("answerChannel");
    expect(ensure).toHaveBeenCalledWith("s-1", OWNER);
    expect(sent).toEqual([{ chat: OWNER, text: "done" }]);
  });

  it("matches the owner when the sender JID carries a device suffix", async () => {
    const { ctx, runTurn } = makeCtx({ ownerIds: [OWNER] });
    await handleWhatsAppMessage(dm("hi", "15550002222:4@s.whatsapp.net"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("matches an owner through the alternate id of a privacy-id chat", async () => {
    const { ctx, runTurn, sent } = makeCtx();
    await handleWhatsAppMessage(dm("hi", "98765@lid", { remoteJidAlt: OWNER }), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(sent[0]?.chat).toBe("98765@lid");
  });

  it("drops non-owners and refuses everyone when ownerIds is empty", async () => {
    const stranger = makeCtx();
    await handleWhatsAppMessage(dm("hi", STRANGER), stranger.ctx);
    expect(stranger.runTurn).not.toHaveBeenCalled();
    expect(stranger.sent).toEqual([]);
    // The log line carries no phone number.
    expect(JSON.stringify(stranger.logger.warn.mock.calls)).not.toContain("1999");

    const unpaired = makeCtx({ ownerIds: [] });
    await handleWhatsAppMessage(dm("hi"), unpaired.ctx);
    expect(unpaired.runTurn).not.toHaveBeenCalled();
  });

  it("ignores our own messages and status updates", async () => {
    const { ctx, runTurn, sent } = makeCtx();
    await handleWhatsAppMessage(dm("echo", OWNER, { fromMe: true }), ctx);
    await handleWhatsAppMessage(dm("story", "status@broadcast", { participant: OWNER }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("ignores groups unless allowGroups, and then names the sender", async () => {
    const group = dm("status?", GROUP, { participant: "98765@lid", participantAlt: OWNER });
    const off = makeCtx();
    await handleWhatsAppMessage(group, off.ctx);
    expect(off.runTurn).not.toHaveBeenCalled();

    const on = makeCtx({ allowGroups: true });
    await handleWhatsAppMessage(group, on.ctx);
    const prompt = on.runTurn.mock.calls[0]?.[1] as string;
    expect(prompt.split("\n")[0]).toBe('[from] name="Ada" platform=whatsapp user=98765@lid');
    expect(on.sent[0]?.chat).toBe(GROUP);
  });

  it("ignores a non-owner inside an allowed group", async () => {
    const { ctx, runTurn } = makeCtx({ allowGroups: true });
    await handleWhatsAppMessage(dm("hey bot", GROUP, { participant: STRANGER }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("runs a redelivered message once", async () => {
    const { ctx, runTurn } = makeCtx();
    const msg = dm("once");
    await handleWhatsAppMessage(msg, ctx);
    await handleWhatsAppMessage(msg, ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps one session per chat, and separate sessions for separate chats", async () => {
    const { ctx, runTurn, dir } = makeCtx({ allowGroups: true });
    await handleWhatsAppMessage(dm("one"), ctx);
    await handleWhatsAppMessage(dm("two"), ctx);
    await handleWhatsAppMessage(dm("three", GROUP, { participant: OWNER }), ctx);
    const ids = runTurn.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["s-1", "s-1", "s-2"]);
    const map = new ChatSessionMap(join(dir, "whatsapp-session.json"));
    expect(map.get(`dm:${OWNER}`).current).toBe("s-1");
    expect(map.get(`group:${GROUP}`).current).toBe("s-2");
  });

  it("consumes an approval answer instead of starting a turn", async () => {
    const { ctx, sent, runTurn, bridge } = makeCtx();
    bridge.handlerFor(OWNER)({ approvalId: "ap-1", tool: "t", category: "c", reason: "r" } as never);
    await handleWhatsAppMessage(dm("yes K7Q2"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent.at(-1)?.text).toBe("Approved.");
  });

  it("does not let a stranger answer an approval", async () => {
    const { ctx, bridge, sent } = makeCtx();
    const resolveSpy = vi.spyOn(bridge, "tryAnswer");
    bridge.handlerFor(OWNER)({ approvalId: "ap-1", tool: "t", category: "c", reason: "r" } as never);
    await handleWhatsAppMessage(dm("yes K7Q2", STRANGER), ctx);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(sent.some((s) => s.text === "Approved.")).toBe(false);
  });

  it("handles /new and /status", async () => {
    const { ctx, sent } = makeCtx();
    await handleWhatsAppMessage(dm("hello"), ctx);
    await handleWhatsAppMessage(dm("/status"), ctx);
    expect(sent.at(-1)?.text).toBe("This chat is on session s-1.");
    await handleWhatsAppMessage(dm("/new"), ctx);
    expect(sent.at(-1)?.text).toMatch(/Previous session s-1 archived/);
    expect(ctx.releaseApprovalSession).toHaveBeenCalledWith("s-1");
    await handleWhatsAppMessage(dm("/status"), ctx);
    expect(sent.at(-1)?.text).toBe("No session for this chat yet.");
  });

  it("chunks a long reply at 2000 characters", async () => {
    const long = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
    const { ctx, sent } = makeCtx({}, long);
    await handleWhatsAppMessage(dm("write a lot"), ctx);
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.text.length <= 2000)).toBe(true);
    expect(sent.map((s) => s.text).join("")).toContain("b".repeat(1500));
  });

  it("refuses media with a notice, and still runs a caption", async () => {
    const { ctx, sent, runTurn } = makeCtx();
    await handleWhatsAppMessage(
      { key: { remoteJid: OWNER, id: "P1" }, message: { audioMessage: {} } },
      ctx,
    );
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent[0]?.text).toMatch(/not supported on WhatsApp yet/);

    await handleWhatsAppMessage(
      { key: { remoteJid: OWNER, id: "P2" }, message: { imageMessage: { caption: "read this" } } },
      ctx,
    );
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toBe("read this");
  });

  it("never throws when sending fails", async () => {
    const { ctx } = makeCtx({
      send: async () => {
        throw new Error("WhatsApp is not connected");
      },
    });
    await expect(handleWhatsAppMessage(dm("/help"), ctx)).resolves.toBeUndefined();
  });
});
