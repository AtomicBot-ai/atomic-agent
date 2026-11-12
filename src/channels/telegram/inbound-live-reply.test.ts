import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { createAttachmentInbox } from "../attachments/inbox.js";
import { handleInboundText, type InboundContext, type InboundTextUpdate } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

// ATO-634: a DM turn streams its reply into one message that the final,
// formatted reply replaces; without the switch the old path is unchanged.

const OWNER = 42;
const CHAT = 100;
const FIRST = "The answer is **forty-two**, and here is why it matters a lot.";

function update(text: string): InboundTextUpdate {
  return { from: { id: OWNER }, chat: { id: CHAT, type: "private" }, text, message_id: 1 };
}

const delta = (text: string): AgentLoopEvent =>
  ({ type: "llm_event", event: { type: "assistant_delta", text } }) as AgentLoopEvent;
const reply = (text: string): AgentLoopEvent =>
  ({ type: "llm_event", event: { type: "assistant_reply", text } }) as AgentLoopEvent;

interface Api extends TelegramApi {
  sent: { text: string; opts?: Record<string, unknown> }[];
  edits: { messageId: number; text: string; opts?: Record<string, unknown> }[];
}

function makeApi(): Api {
  const sent: Api["sent"] = [];
  const edits: Api["edits"] = [];
  return {
    sent,
    edits,
    sendMessage: vi.fn(async (_chat: number, text: string, opts?: Record<string, unknown>) => {
      sent.push({ text, ...(opts ? { opts } : {}) });
      return { message_id: sent.length };
    }),
    editMessageText: vi.fn(
      async (_chat: number, messageId: number, text: string, opts?: Record<string, unknown>) => {
        edits.push({ messageId, text, ...(opts ? { opts } : {}) });
        return true;
      },
    ),
    deleteMessage: vi.fn(async () => true),
  };
}

function makeRuntime(events: AgentLoopEvent[]): AgentRuntime {
  const sessions: SessionState[] = [];
  return {
    createSession: () => {
      const s = createEmptySessionState({ id: `s-${sessions.length + 1}`, workingDir: "/w" });
      sessions.push(s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.find((s) => s.id === id) ?? null },
    turnController: { isBusy: () => false },
    runTurn: async (session: SessionState, _m: string, opts?: { eventHook?: (e: AgentLoopEvent) => void }) => {
      for (const event of events) opts?.eventHook?.(event);
      return { session, reason: "reply" as const, stepCount: 1 };
    },
  } as unknown as AgentRuntime;
}

describe("Telegram streamed replies (ATO-634)", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-live-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(runtime: AgentRuntime, api: TelegramApi, extra: Partial<InboundContext> = {}): InboundContext {
    return {
      runtime,
      api,
      sessionPointer: pointer,
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      inflight: new Map(),
      liveTurns: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
      scheduleSnapshotPoll: () => () => undefined,
      statusSnapshot: { everySteps: 0, everyMs: 0 },
      progressIndicator: false,
      agentReplyParseMode: "html",
      ...extra,
    };
  }

  it("streams the reply into one message and edits in the formatted final text", async () => {
    const api = makeApi();
    const onMessageSent = vi.fn();
    const events = [delta(FIRST), delta(" More."), reply(`${FIRST} More.`)];
    await handleInboundText(
      update("question"),
      ctx(makeRuntime(events), api, { streamReplies: "private", onMessageSent }),
    );
    expect(api.sent.map((m) => m.text)).toEqual([FIRST]);
    expect(api.edits).toEqual([
      {
        messageId: 1,
        text: "The answer is <b>forty-two</b>, and here is why it matters a lot. More.",
        opts: { parse_mode: "HTML", disable_web_page_preview: true },
      },
    ]);
    expect(onMessageSent).toHaveBeenCalledWith(1);
  });

  it("keeps the one-message path when streaming is not switched on", async () => {
    const api = makeApi();
    const events = [delta(FIRST), reply(FIRST)];
    await handleInboundText(update("question"), ctx(makeRuntime(events), api));
    expect(api.sent.map((m) => m.text)).toEqual([
      "The answer is <b>forty-two</b>, and here is why it matters a lot.",
    ]);
    expect(api.edits).toEqual([]);
  });

  it("sends the reply normally when nothing streamed (no deltas)", async () => {
    const api = makeApi();
    await handleInboundText(
      update("question"),
      ctx(makeRuntime([reply("plain answer")]), api, { streamReplies: "private" }),
    );
    expect(api.sent.map((m) => m.text)).toEqual(["plain answer"]);
    expect(api.edits).toEqual([]);
  });

  it("leaves the streamed text in place when the turn fails, then reports the failure", async () => {
    const api = makeApi();
    const events: AgentLoopEvent[] = [
      delta(FIRST),
      { type: "loop_failed", error: new Error("boom"), category: "llm" } as unknown as AgentLoopEvent,
    ];
    await handleInboundText(
      update("question"),
      ctx(makeRuntime(events), api, { streamReplies: "private" }),
    );
    expect(api.sent[0]!.text).toBe(FIRST);
    expect(api.sent[1]!.text).toContain("Turn failed");
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });
});
