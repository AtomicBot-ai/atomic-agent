/**
 * `/fork` over Telegram (ATO-2235), end to end through `handleInboundText`
 * with a real session pointer file and a fake Bot API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { handleInboundText, type InboundContext, type InboundTextUpdate } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

const OWNER = 42;
const DM = 100;
const GROUP = -1001;
const TOPIC = 777;
const BOT = { id: 7, username: "atomic_bot" };

function sourceSession(id: string): SessionState {
  const state = createEmptySessionState({
    id,
    workingDir: "/tmp/test",
    metadata: { telegramChannel: true, telegramChat: { id: DM, type: "private", label: "DM" } },
  });
  state.turns = [
    { kind: "user", text: "plan the trip", at: 1 },
    { kind: "assistant_reply", text: "Here is a plan.", at: 2 },
    { kind: "user", text: "make it cheaper", at: 3 },
    { kind: "assistant_reply", text: "Cheaper plan.", at: 4 },
  ];
  state.turnCount = 2;
  state.macroTurnStarts = [2, 4];
  return state;
}

function makeRuntime(initial: SessionState[]) {
  const sessions = new Map(initial.map((s) => [s.id, s]));
  const saved: SessionState[] = [];
  const busy = new Set<string>();
  const runtime = {
    sessionStore: {
      load: (id: string) => sessions.get(id) ?? null,
      save: (state: SessionState) => {
        saved.push(state);
        sessions.set(state.id, state);
      },
    },
    turnController: { isBusy: (id: string) => busy.has(id) },
    runTurn: vi.fn(),
    createSession: vi.fn(),
  } as unknown as AgentRuntime;
  return { runtime, sessions, saved, busy };
}

function makeApi(createForumTopic?: TelegramApi["createForumTopic"]) {
  const sent: Array<{ chatId: number; text: string; opts?: Record<string, unknown> }> = [];
  const api: TelegramApi = {
    sendMessage: vi.fn(async (chatId: number, text: string, opts?: Record<string, unknown>) => {
      sent.push({ chatId, text, ...(opts ? { opts } : {}) });
      return { message_id: sent.length };
    }),
    ...(createForumTopic ? { createForumTopic } : {}),
  };
  return { api, sent };
}

describe("/fork on Telegram", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-fork-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(runtime: AgentRuntime, api: TelegramApi): InboundContext {
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
    };
  }

  const dmUpdate = (text: string): InboundTextUpdate => ({
    from: { id: OWNER },
    chat: { id: DM, type: "private" },
    text,
    message_id: 1,
  });

  const forumUpdate = (text: string): InboundTextUpdate => ({
    from: { id: OWNER },
    chat: { id: GROUP, type: "supergroup", title: "Team", is_forum: true },
    text: `${text}@${BOT.username}`,
    message_id: 1,
  });

  it("in a forum, opens a topic mapped to a copy and leaves the source alone", async () => {
    const source = sourceSession("s-src");
    const before = structuredClone(source);
    const { runtime, saved } = makeRuntime([source]);
    const createForumTopic = vi.fn(async () => ({ message_thread_id: TOPIC, name: "x" }));
    const { api, sent } = makeApi(createForumTopic);
    pointer.setCurrent(String(GROUP), source.id, "Team");

    await handleInboundText(forumUpdate("/fork"), ctxFor(runtime, api));

    expect(createForumTopic).toHaveBeenCalledWith(GROUP, "plan the trip (fork)");
    expect(saved).toHaveLength(1);
    const fork = saved[0]!;
    expect(fork.id).not.toBe(source.id);
    expect(fork.turns).toEqual(source.turns);
    expect(fork.metadata.forkedFrom).toMatchObject({ sessionId: source.id });
    expect(fork.metadata.telegramChat).toMatchObject({ id: GROUP, threadId: TOPIC });
    // The new topic talks to the copy; the chat it came from does not move.
    expect(pointer.get(`${GROUP}:${TOPIC}`).current).toBe(fork.id);
    expect(pointer.get(String(GROUP)).current).toBe(source.id);
    expect(source).toEqual(before);
    expect(sent.some((m) => m.opts?.message_thread_id === TOPIC && m.text.includes(source.id))).toBe(true);
  });

  it("forks in place when the bot may not create topics", async () => {
    const source = sourceSession("s-src");
    const { runtime, saved } = makeRuntime([source]);
    const createForumTopic = vi.fn(async () => {
      throw new Error("Bad Request: not enough rights to create a topic");
    });
    const { api } = makeApi(createForumTopic);
    pointer.setCurrent(String(GROUP), source.id, "Team");

    await handleInboundText(forumUpdate("/fork"), ctxFor(runtime, api));

    expect(createForumTopic).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(pointer.get(String(GROUP)).current).toBe(saved[0]!.id);
  });

  it("outside a forum, moves this chat to a copy and keeps the source in its history", async () => {
    const source = sourceSession("s-src");
    const before = structuredClone(source);
    const { runtime, saved } = makeRuntime([source]);
    const createForumTopic = vi.fn();
    const { api, sent } = makeApi(createForumTopic);
    pointer.setCurrent(String(DM), source.id, "DM");

    await handleInboundText(dmUpdate("/fork"), ctxFor(runtime, api));

    expect(createForumTopic).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    const fork = saved[0]!;
    expect(fork.turns).toEqual(source.turns);
    const entry = pointer.get(String(DM));
    expect(entry.current).toBe(fork.id);
    expect(entry.history).toContain(source.id);
    expect(source).toEqual(before);
    expect(sent.at(-1)?.text).toContain(`forked from ${source.id}`);
  });

  it("refuses while a turn runs on the session and saves nothing", async () => {
    const source = sourceSession("s-src");
    const { runtime, saved, busy } = makeRuntime([source]);
    busy.add(source.id);
    const { api, sent } = makeApi();
    pointer.setCurrent(String(DM), source.id, "DM");

    await handleInboundText(dmUpdate("/fork"), ctxFor(runtime, api));

    expect(saved).toHaveLength(0);
    expect(pointer.get(String(DM)).current).toBe(source.id);
    expect(sent.at(-1)?.text).toContain("A turn is running here");
  });

  it("says there is nothing to fork in a chat without a session", async () => {
    const { runtime, saved } = makeRuntime([]);
    const { api, sent } = makeApi();

    await handleInboundText(dmUpdate("/fork"), ctxFor(runtime, api));

    expect(saved).toHaveLength(0);
    expect(sent.at(-1)?.text).toContain("No session here yet");
  });

  it("lists /fork in /help", async () => {
    const { runtime } = makeRuntime([]);
    const { api, sent } = makeApi();

    await handleInboundText(dmUpdate("/help"), ctxFor(runtime, api));

    expect(sent.at(-1)?.text).toContain("/fork");
  });
});
