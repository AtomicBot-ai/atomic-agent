import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { rotateGuestSession } from "./guest-session-reset.js";
import { handleInboundText, type InboundContext, type InboundTextUpdate } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer, telegramGuestChatKey } from "./telegram-session-pointer.js";

/** ATO-2703: the owner's `/new` in a group also starts the guests' session over. */
const OWNER = 42;
const GUEST = 77;
const GROUP = -1001;
const BOT = { id: 7, username: "atomic_bot" };
const GUEST_KEY = telegramGuestChatKey(String(GROUP));

function fakeRuntime(): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = [];
  const sessions: SessionState[] = [];
  let n = 0;
  const runtime = {
    createSession: (input: { metadata?: Record<string, unknown> } = {}) => {
      const s = createEmptySessionState({ id: `s-${++n}`, workingDir: "/tmp/test", ...(input.metadata ? { metadata: input.metadata } : {}) });
      sessions.push(s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.find((s) => s.id === id) ?? null },
    turnController: { isBusy: () => false },
    toolRegistry: { has: () => true, get: () => ({ readonly: true }) },
    runTurn: async (session: SessionState) => {
      calls.push(session.id);
      return { session, reason: "reply" as const, stepCount: 1 };
    },
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

function fakeApi(): TelegramApi & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendMessage: vi.fn(async (_chatId: number, text: string) => {
      sent.push(text);
      return { message_id: sent.length };
    }),
    sendChatAction: vi.fn(async () => undefined),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  } as unknown as TelegramApi & { sent: string[] };
}

const group = (text: string, fromId: number): InboundTextUpdate => ({
  from: { id: fromId },
  chat: { id: GROUP, type: "supergroup", title: "Ops" },
  text,
  message_id: 1,
});

describe("owner /new in a group resets the guest session (ATO-2703)", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-guest-new-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = (runtime: AgentRuntime, api: TelegramApi, extra: Partial<InboundContext> = {}): InboundContext => ({
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
  });

  it("starts both the owner's and the guests' conversations over", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = fakeApi();
    const releaseApprovalSession = vi.fn();
    const c = ctx(runtime, api, { releaseApprovalSession });
    await handleInboundText(group("@atomic_bot deploy", OWNER), c);
    await handleInboundText(group("@atomic_bot what is in README?", GUEST), c);
    const [owner, guest] = calls;
    expect(pointer.get(GUEST_KEY).current).toBe(guest);

    await handleInboundText(group("/new@atomic_bot", OWNER), c);
    expect(pointer.get(String(GROUP)).current).toBeNull();
    expect(pointer.get(GUEST_KEY).current).toBeNull();
    expect(pointer.get(GUEST_KEY).history).toContain(guest);
    expect(releaseApprovalSession).toHaveBeenCalledWith(owner);
    expect(releaseApprovalSession).toHaveBeenCalledWith(guest);
    expect(api.sent.at(-1)).toContain("The guests' conversation starts over too.");

    await handleInboundText(group("@atomic_bot hi again", GUEST), c);
    expect(calls[2]).not.toBe(guest);
    expect(calls[2]).not.toBe(owner);
  });

  it("says nothing about guests when the group has no guest session", async () => {
    const { runtime } = fakeRuntime();
    const api = fakeApi();
    const c = ctx(runtime, api);
    await handleInboundText(group("@atomic_bot deploy", OWNER), c);
    await handleInboundText(group("/new@atomic_bot", OWNER), c);
    expect(api.sent.at(-1)).not.toContain("guests");
  });
});

describe("rotateGuestSession", () => {
  it("keeps a running guest turn's approval binding until it settles", () => {
    const rotate = vi.fn();
    const releaseApprovalSession = vi.fn();
    const sessionPointer = { get: () => ({ current: "g-1", history: [] }), rotate } as unknown as Parameters<typeof rotateGuestSession>[1]["sessionPointer"];
    const previous = rotateGuestSession("-5", {
      sessionPointer,
      inflight: new Map([[telegramGuestChatKey("-5"), new AbortController()]]),
      releaseApprovalSession,
    });
    expect(previous).toBe("g-1");
    expect(rotate).toHaveBeenCalledWith(telegramGuestChatKey("-5"));
    expect(releaseApprovalSession).not.toHaveBeenCalled();
  });
});
