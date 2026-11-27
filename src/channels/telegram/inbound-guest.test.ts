import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { isChannelGuestSession } from "../../session/channel-guest-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { createAttachmentInbox } from "../attachments/inbox.js";
import {
  handleInboundText,
  type InboundContext,
  type InboundTextUpdate,
} from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import {
  TelegramSessionPointer,
  telegramGuestChatKey,
} from "./telegram-session-pointer.js";

/** Guests in groups (ATO-2221), end to end through the inbound handler. */

const OWNER = 42;
const GUEST = 77;
const STRANGER = 99;
const GROUP = -1001;
const BOT = { id: 7, username: "atomic_bot" };

interface Call {
  sessionId: string;
  userMessage: string;
  opts: {
    toolFilter?: (name: string) => boolean;
    memoryReadOnly?: boolean;
  };
}

function fakeRuntime(): {
  runtime: AgentRuntime;
  calls: Call[];
  sessions: SessionState[];
} {
  const calls: Call[] = [];
  const sessions: SessionState[] = [];
  let n = 0;
  // A registry with one read tool, one write tool and one private read.
  const tools: Record<string, { readonly: boolean }> = {
    "os.fs.read": { readonly: true },
    "os.fs.write": { readonly: false },
    "os.email.inbox": { readonly: true },
  };
  const runtime = {
    createSession: (input: { metadata?: Record<string, unknown> } = {}) => {
      const s = createEmptySessionState({
        id: `s-${++n}`,
        workingDir: "/tmp/test",
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      sessions.push(s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.find((s) => s.id === id) ?? null },
    turnController: { isBusy: () => false },
    toolRegistry: {
      has: (name: string) => name in tools,
      get: (name: string) => tools[name],
    },
    runTurn: async (
      session: SessionState,
      userMessage: string,
      opts: Call["opts"] & { eventHook?: (e: AgentLoopEvent) => void },
    ) => {
      calls.push({ sessionId: session.id, userMessage, opts });
      opts.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "ok" },
      } as AgentLoopEvent);
      return { session, reason: "reply" as const, stepCount: 1 };
    },
  } as unknown as AgentRuntime;
  return { runtime, calls, sessions };
}

function fakeApi(): TelegramApi & { sent: Array<{ chatId: number; text: string }> } {
  const sent: Array<{ chatId: number; text: string }> = [];
  return {
    sent,
    sendMessage: vi.fn(async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    }),
    sendChatAction: vi.fn(async () => undefined),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  } as unknown as TelegramApi & { sent: Array<{ chatId: number; text: string }> };
}

function groupUpdate(
  text: string,
  fromId: number,
  over: Partial<InboundTextUpdate> = {},
): InboundTextUpdate {
  return {
    from: { id: fromId },
    chat: { id: GROUP, type: "supergroup", title: "Ops" },
    text,
    message_id: 1,
    ...over,
  };
}

describe("handleInboundText: guests in groups (ATO-2221)", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-guest-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(
    runtime: AgentRuntime,
    api: TelegramApi,
    extra: Partial<InboundContext> = {},
  ): InboundContext {
    return {
      runtime,
      api,
      sessionPointer: pointer,
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      botIdentity: BOT,
      inflight: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
      allowedUsers: [{ userId: GUEST, role: "guest" }],
      ...extra,
    };
  }

  it("accepts a guest's mention with role=guest and runs the turn read-only", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(groupUpdate("@atomic_bot what is in README?", GUEST), ctx(runtime, api));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe(
      `[from] platform=telegram user=${GUEST} chat=${GROUP} role=guest\nwhat is in README?`,
    );
    const filter = calls[0]!.opts.toolFilter;
    expect(filter).toBeDefined();
    expect(filter!("os.fs.read")).toBe(true);
    expect(filter!("os.fs.write")).toBe(false);
    expect(filter!("os.email.inbox")).toBe(false);
    expect(filter!("ask_user")).toBe(false);
    expect(filter!("reply")).toBe(true);
    expect(calls[0]!.opts.memoryReadOnly).toBe(true);
    expect(api.sent.at(-1)).toEqual({ chatId: GROUP, text: "ok" });
  });

  it("stays silent when a guest does not address the bot", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(groupUpdate("just chatting", GUEST), ctx(runtime, api));
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("drops an unknown user even when they mention the bot", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(groupUpdate("@atomic_bot hi", STRANGER), ctx(runtime, api));
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("does not hear a guest in a DM", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(
      { from: { id: GUEST }, chat: { id: GUEST, type: "private" }, text: "hi", message_id: 1 },
      ctx(runtime, api),
    );
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("drops guests when no owner is configured", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(
      groupUpdate("@atomic_bot hi", GUEST),
      ctx(runtime, api, { ownerUserId: null }),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a guest's owner command but answers /help", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    const c = ctx(runtime, api);
    await handleInboundText(groupUpdate("/new@atomic_bot", GUEST), c);
    expect(api.sent.at(-1)!.text).toContain("/new is for the bot's owner");
    expect(pointer.get(String(GROUP)).current).toBeNull();
    await handleInboundText(groupUpdate("/cancel@atomic_bot", GUEST), c);
    expect(api.sent.at(-1)!.text).toContain("/cancel is for the bot's owner");
    await handleInboundText(groupUpdate("/help@atomic_bot", GUEST), c);
    expect(api.sent.at(-1)!.text).toContain("Telegram remote control");
    expect(calls).toHaveLength(0);
  });

  it("routes a group session's approvals to the owner's DM when guests exist", async () => {
    const { runtime } = fakeRuntime();
    const api = fakeApi();
    const ensureApprovalSession = vi.fn();
    await handleInboundText(
      groupUpdate("@atomic_bot hi", GUEST),
      ctx(runtime, api, { ensureApprovalSession }),
    );
    expect(ensureApprovalSession).toHaveBeenCalledWith(
      expect.any(String),
      { chatId: OWNER },
      { shared: true },
    );
  });

  it("tags the owner role=owner with guests configured, full tools", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    await handleInboundText(groupUpdate("@atomic_bot deploy", OWNER), ctx(runtime, api));
    expect(calls[0]!.userMessage).toBe(
      `[from] platform=telegram user=${OWNER} chat=${GROUP} role=owner\ndeploy`,
    );
    expect(calls[0]!.opts.toolFilter).toBeUndefined();
    expect(calls[0]!.opts.memoryReadOnly).toBeUndefined();
  });

  it("leaves the owner unchanged without guests: no role, group-bound approvals", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    const ensureApprovalSession = vi.fn();
    await handleInboundText(
      groupUpdate("@atomic_bot deploy", OWNER),
      ctx(runtime, api, { allowedUsers: [], ensureApprovalSession }),
    );
    expect(calls[0]!.userMessage).toBe(
      `[from] platform=telegram user=${OWNER} chat=${GROUP}\ndeploy`,
    );
    expect(calls[0]!.opts.toolFilter).toBeUndefined();
    expect(ensureApprovalSession).toHaveBeenCalledWith(expect.any(String), {
      chatId: GROUP,
    });
  });
  it("runs guests in the group's own guest session, apart from the owner's", async () => {
    const { runtime, calls, sessions } = fakeRuntime();
    const api = fakeApi();
    const c = ctx(runtime, api);
    await handleInboundText(groupUpdate("@atomic_bot deploy", OWNER), c);
    await handleInboundText(groupUpdate("@atomic_bot what is in README?", GUEST), c);
    await handleInboundText(groupUpdate("@atomic_bot and the license?", GUEST), c);
    expect(calls).toHaveLength(3);
    const [owner, guest, guestAgain] = calls.map((call) => call.sessionId);
    expect(guest).not.toBe(owner);
    expect(guestAgain).toBe(guest);
    expect(pointer.get(String(GROUP)).current).toBe(owner);
    expect(pointer.get(telegramGuestChatKey(String(GROUP))).current).toBe(guest);
    const byId = (id: string | undefined) => sessions.find((s) => s.id === id)!;
    expect(isChannelGuestSession(byId(guest))).toBe(true);
    expect(isChannelGuestSession(byId(owner))).toBe(false);
    // The guests' replies still land in the group.
    expect(api.sent.at(-1)).toEqual({ chatId: GROUP, text: "ok" });
  });

  it("never reuses a non-guest session for guests, and leaves its binding alone", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    const releaseApprovalSession = vi.fn();
    const c = ctx(runtime, api, { releaseApprovalSession });
    await handleInboundText(groupUpdate("@atomic_bot deploy", OWNER), c);
    const owner = calls[0]!.sessionId;
    // A hand-edited map pointing the guests at the owner's session.
    pointer.setCurrent(telegramGuestChatKey(String(GROUP)), owner);
    await handleInboundText(groupUpdate("@atomic_bot hi", GUEST), c);
    expect(calls[1]!.sessionId).not.toBe(owner);
    expect(releaseApprovalSession).not.toHaveBeenCalledWith(owner);
  });

  it("lets the owner's /cancel stop a guest turn in the group", async () => {
    const { runtime } = fakeRuntime();
    const api = fakeApi();
    const controller = new AbortController();
    const c = ctx(runtime, api);
    c.inflight.set(telegramGuestChatKey(String(GROUP)), controller);
    await handleInboundText(groupUpdate("/cancel@atomic_bot", OWNER), c);
    expect(controller.signal.aborted).toBe(true);
  });
});
