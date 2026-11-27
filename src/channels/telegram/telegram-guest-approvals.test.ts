import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import {
  TelegramChannel,
  type BotFactory,
  type BotInstance,
  type ChannelLock,
} from "./telegram-channel.js";

/**
 * ATO-2221: with guests configured, a group session's approvals go to
 * the owner's DM as a `shared` binding. That binding must not evict the
 * owner's own DM session (same chat id), and the DM session must not
 * evict it either.
 */

const OWNER = 42;
const GUEST = 77;
const GROUP = -100;

function makeFactory(): {
  factory: BotFactory;
  state: {
    textHandler: ((u: unknown) => void | Promise<void>) | null;
    sent: Array<{ chatId: number; text: string }>;
  };
} {
  const state = {
    textHandler: null as ((u: unknown) => void | Promise<void>) | null,
    sent: [] as Array<{ chatId: number; text: string }>,
  };
  const factory: BotFactory = () => {
    const bot: BotInstance = {
      api: {
        sendMessage: vi.fn(async (chatId: number, text: string) => {
          state.sent.push({ chatId, text });
          return { message_id: state.sent.length };
        }),
        editMessageText: vi.fn(async () => undefined),
        answerCallbackQuery: vi.fn(async () => undefined),
        getMe: vi.fn(async () => ({ id: 1, username: "test_bot" })),
        setMyCommands: vi.fn(async () => undefined),
      },
      setTextHandler(handler: (u: unknown) => void | Promise<void>) {
        state.textHandler = handler;
      },
      setCallbackHandler() {},
      setFileHandler() {},
      start() {},
      async stop() {},
      abandon() {},
    } as unknown as BotInstance;
    return bot;
  };
  return { factory, state };
}

const lock: ChannelLock = { acquire() {}, release() {} };

function runtimeWith(setHandler: ReturnType<typeof vi.fn>): AgentRuntime {
  const sessions = new Map<string, { id: string; metadata: object }>();
  let n = 0;
  return {
    approvals: { resolve: vi.fn(() => true) },
    setApprovalHandlerForSession: setHandler,
    createSession: () => {
      const s = { id: `s-${++n}`, metadata: { telegramChannel: true } };
      sessions.set(s.id, s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
    turnController: { isBusy: () => false },
    runTurn: async (
      _s: unknown,
      _t: string,
      opts: { eventHook?: (e: unknown) => void },
    ) => {
      opts.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "ok" },
      });
      return {};
    },
  } as unknown as AgentRuntime;
}

function config(stateDir: string): AtomicAgentConfig {
  return {
    paths: { stateDir },
    telegram: {
      enabled: true,
      ownerUserId: OWNER,
      parseMode: "plain",
      allowedUsers: [{ userId: GUEST, role: "guest" }],
    },
  } as unknown as AtomicAgentConfig;
}

function request(approvalId: string, sessionId: string): ApprovalRequest {
  return {
    approvalId,
    sessionId,
    tool: "os.fs.read",
    category: "other",
    reason: "read outside the workspace",
    preview: "~/notes.txt",
  } as ApprovalRequest;
}

describe("TelegramChannel guest approvals (ATO-2221)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-guest-appr-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes a guest group turn's approvals to the owner's DM without evicting the DM session", async () => {
    const { factory, state } = makeFactory();
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const setHandler = vi.fn((_sessionId: string, _handler: (r: ApprovalRequest) => void) => {
      const u = vi.fn();
      unsubscribes.push(u);
      return u;
    });
    const channel = new TelegramChannel({
      runtime: runtimeWith(setHandler),
      config: config(dir),
      token: "1234:abcdef",
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    const dm = {
      from: { id: OWNER },
      chat: { id: OWNER, type: "private" },
      text: "hi",
      message_id: 1,
    };
    await state.textHandler!(dm);
    await state.textHandler!({
      from: { id: GUEST, first_name: "Gia" },
      chat: { id: GROUP, type: "supergroup", title: "Ops" },
      text: "@test_bot what is in the readme?",
      message_id: 2,
    });
    // DM session s-1 and group session s-2, both bound, neither evicted.
    expect(setHandler.mock.calls.map((c) => c[0])).toEqual(["s-1", "s-2"]);
    expect(unsubscribes[0]!).not.toHaveBeenCalled();

    // The group session's approval prompt lands in the owner's DM.
    const groupRoute = setHandler.mock.calls[1]?.[1] as
      | ((r: ApprovalRequest) => void)
      | undefined;
    if (groupRoute === undefined) throw new Error("expected the group route");
    const before = state.sent.length;
    groupRoute(request("a-1", "s-2"));
    await new Promise((r) => setImmediate(r));
    const prompts = state.sent.slice(before);
    expect(prompts.some((m) => m.chatId === OWNER)).toBe(true);
    expect(prompts.some((m) => m.chatId === GROUP)).toBe(false);

    // A fresh DM session binds the same chat id; the shared group
    // binding survives it.
    await state.textHandler!({ ...dm, text: "/new", message_id: 3 });
    await state.textHandler!({ ...dm, text: "again", message_id: 4 });
    expect(setHandler.mock.calls.map((c) => c[0])).toEqual([
      "s-1",
      "s-2",
      "s-3",
    ]);
    expect(unsubscribes[1]!).not.toHaveBeenCalled();
    await channel.stop();
  });
});
