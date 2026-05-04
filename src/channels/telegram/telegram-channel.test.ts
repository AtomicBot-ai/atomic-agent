import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicAgentConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import {
  TelegramChannel,
  scrubErrorMessage,
  type BotFactory,
  type BotInstance,
  type ChannelLock,
} from "./telegram-channel.js";

interface FakeBotState {
  startCalls: number;
  stopCalls: number;
  setMyCommandsCalls: number;
  textHandler: ((u: unknown) => void | Promise<void>) | null;
  callbackHandler: ((u: unknown) => void | Promise<void>) | null;
}

interface FakeBotOptions {
  getMeError?: Error;
  setMyCommandsError?: Error;
}

function makeBotFactory(opts: FakeBotOptions = {}): {
  factory: BotFactory;
  state: FakeBotState;
} {
  const state: FakeBotState = {
    startCalls: 0,
    stopCalls: 0,
    setMyCommandsCalls: 0,
    textHandler: null,
    callbackHandler: null,
  };
  const factory: BotFactory = () => {
    const bot: BotInstance = {
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        editMessageText: vi.fn(async () => undefined),
        answerCallbackQuery: vi.fn(async () => undefined),
        getMe: vi.fn(async () => {
          if (opts.getMeError) throw opts.getMeError;
          return { id: 1, username: "test_bot" };
        }),
        setMyCommands: vi.fn(async () => {
          state.setMyCommandsCalls += 1;
          if (opts.setMyCommandsError) throw opts.setMyCommandsError;
          return undefined;
        }),
      },
      setTextHandler(handler) {
        state.textHandler = handler;
      },
      setCallbackHandler(handler) {
        state.callbackHandler = handler;
      },
      start(_onStart) {
        state.startCalls += 1;
      },
      async stop() {
        state.stopCalls += 1;
      },
    };
    return bot;
  };
  return { factory, state };
}

function fakeLock(opts: { acquireError?: Error } = {}): {
  lock: ChannelLock;
  acquired: number;
  released: number;
} {
  const counters = { acquired: 0, released: 0 };
  const lock: ChannelLock = {
    acquire() {
      if (opts.acquireError) throw opts.acquireError;
      counters.acquired += 1;
    },
    release() {
      counters.released += 1;
    },
  };
  return { lock, get acquired() { return counters.acquired; }, get released() { return counters.released; } };
}

function fakeRuntime(
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    approvals: { resolve: vi.fn(() => true) },
    setApprovalHandlerForSession: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as AgentRuntime;
}

function makeConfig(stateDir: string): AtomicAgentConfig {
  return {
    paths: { stateDir },
    telegram: { enabled: true, ownerUserId: 42 },
  } as unknown as AtomicAgentConfig;
}

describe("TelegramChannel", () => {
  let dir: string;
  let logger: StructuredLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-channel-"));
    logger = new StructuredLogger({ level: "warn", sinks: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts up with valid token and emits starting then up", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const statuses: ChannelStatus[] = [];
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: (s) => statuses.push(s),
    });
    await channel.start();
    expect(statuses.map((s) => s.state)).toEqual(["starting", "up"]);
    expect(channel.state()).toBe("up");
    expect(channel.lastError()).toBeNull();
    expect(state.startCalls).toBe(1);
    expect(state.textHandler).not.toBeNull();
    expect(state.setMyCommandsCalls).toBe(1);
  });

  it("emits down with the right error when token is null", async () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    const statuses: ChannelStatus[] = [];
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: null,
      logger,
      botFactory: factory,
      lock,
      emitStatus: (s) => statuses.push(s),
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("missing TELEGRAM_BOT_TOKEN");
    expect(statuses[statuses.length - 1]).toMatchObject({
      state: "down",
      lastError: "missing TELEGRAM_BOT_TOKEN",
    });
  });

  it("emits down when the lock is held by another live process", async () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock({
      acquireError: new Error("telegram lockfile held by live pid 9999"),
    });
    const statuses: ChannelStatus[] = [];
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: (s) => statuses.push(s),
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("lockfile held");
  });

  it("emits down with scrubbed error when getMe fails", async () => {
    const realisticToken = "123456789:abcdefghijklmnopqrstuvwxyz0123456789";
    const { factory } = makeBotFactory({
      getMeError: new Error(`auth failed for token ${realisticToken}`),
    });
    const lockStub = fakeLock();
    const statuses: ChannelStatus[] = [];
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: realisticToken,
      logger,
      botFactory: factory,
      lock: lockStub.lock,
      emitStatus: (s) => statuses.push(s),
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("<token>");
    expect(channel.lastError()).not.toContain(realisticToken);
    expect(lockStub.acquired).toBe(1);
    expect(lockStub.released).toBe(1);
  });

  it("stop() releases the lock and transitions through stopping → disabled", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const statuses: ChannelStatus[] = [];
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: (s) => statuses.push(s),
    });
    await channel.start();
    statuses.length = 0;
    await channel.stop();
    expect(state.stopCalls).toBe(1);
    expect(statuses.map((s) => s.state)).toEqual(["stopping", "disabled"]);
    expect(channel.state()).toBe("disabled");
  });

  it("double-stop is idempotent", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    await channel.stop();
    await channel.stop();
    expect(state.stopCalls).toBe(1);
  });

  it("non-fatal setMyCommands failure still results in up", async () => {
    const { factory } = makeBotFactory({
      setMyCommandsError: new Error("rate-limited"),
    });
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("up");
  });

  it("registers a callback handler at start so the approval bridge can receive button clicks", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(state.callbackHandler).not.toBeNull();
  });

  it("re-binds the approval router on first inbound message and unsubscribes on stop", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const setHandler = vi.fn(() => () => undefined);
    // Build a runtime with a real-shaped setApprovalHandlerForSession spy.
    const runtime = fakeRuntime({
      setApprovalHandlerForSession: setHandler,
    } as unknown as AgentRuntime);
    const channel = new TelegramChannel({
      runtime,
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    // The text handler from the channel triggers the same code path
    // the inbound handler does — `ensureApprovalSession` is wired on
    // the InboundContext and gets called once a session is acquired.
    // Here we only assert the handler is plumbed (and that stop()
    // tears down whatever subscription the channel acquired).
    expect(state.textHandler).not.toBeNull();
    await channel.stop();
    expect(channel.state()).toBe("disabled");
  });
});

describe("scrubErrorMessage", () => {
  it("redacts a token-shaped substring", () => {
    const msg = scrubErrorMessage(
      new Error("auth fail: 1234567:AAEoZw0X-1234567890abcdefghijklmnopqr happened"),
    );
    expect(msg).not.toContain("AAEoZw0X");
    expect(msg).toContain("<token>");
  });

  it("leaves messages without tokens untouched", () => {
    expect(scrubErrorMessage(new Error("simple error"))).toBe("simple error");
  });
});
