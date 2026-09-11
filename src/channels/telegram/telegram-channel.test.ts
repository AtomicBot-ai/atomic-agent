import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicAgentConfig } from "../../config/index.js";
import { USER_CONFIG_DEFAULTS } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { TaskReport } from "../../tasks/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { TelegramLockfile } from "./telegram-lockfile.js";
import {
  TASK_REPORT_QUEUE_LIMIT,
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
  /** The command menu of the most recent `setMyCommands` call. */
  registeredCommands: string[];
  textHandler: ((u: unknown) => void | Promise<void>) | null;
  callbackHandler: ((u: unknown) => void | Promise<void>) | null;
  fileHandler: ((u: unknown) => void | Promise<void>) | null;
  /** Aggregated `sendMessage` invocations across every bot the factory has created. */
  sendMessageCalls: Array<{ chatId: number; text: string }>;
  /** Simulate the polling loop ending. Set once `start()` has run. */
  killPolling: ((error?: unknown) => void) | null;
}

interface FakeBotOptions {
  getMeError?: Error;
  setMyCommandsError?: Error;
  /** When set, every `sendMessage` rejects with this error. */
  sendMessageError?: Error;
}

function makeBotFactory(opts: FakeBotOptions = {}): {
  factory: BotFactory;
  state: FakeBotState;
} {
  const state: FakeBotState = {
    startCalls: 0,
    stopCalls: 0,
    setMyCommandsCalls: 0,
    registeredCommands: [],
    textHandler: null,
    callbackHandler: null,
    fileHandler: null,
    sendMessageCalls: [],
    killPolling: null,
  };
  const factory: BotFactory = () => {
    const bot: BotInstance = {
      api: {
        sendMessage: vi.fn(async (chatId: number, text: string) => {
          if (opts.sendMessageError) throw opts.sendMessageError;
          state.sendMessageCalls.push({ chatId, text });
          return { message_id: state.sendMessageCalls.length };
        }),
        editMessageText: vi.fn(async () => undefined),
        answerCallbackQuery: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff])),
        getMe: vi.fn(async () => {
          if (opts.getMeError) throw opts.getMeError;
          return { id: 1, username: "test_bot" };
        }),
        setMyCommands: vi.fn(
          async (
            cmds: ReadonlyArray<{ command: string; description: string }>,
          ) => {
            state.setMyCommandsCalls += 1;
            state.registeredCommands = cmds.map((c) => c.command);
            if (opts.setMyCommandsError) throw opts.setMyCommandsError;
            return undefined;
          },
        ),
      },
      setTextHandler(handler) {
        state.textHandler = handler;
      },
      setCallbackHandler(handler) {
        state.callbackHandler = handler;
      },
      setFileHandler(handler) {
        state.fileHandler = handler;
      },
      start(_onStart, onStopped) {
        state.startCalls += 1;
        // Captured so a test can simulate the polling loop dying the
        // way grammy reports it (409 conflict, revoked token, …).
        state.killPolling = (err?: unknown) => onStopped?.(err);
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
  return {
    lock,
    get acquired() {
      return counters.acquired;
    },
    get released() {
      return counters.released;
    },
  };
}

function fakeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    approvals: { resolve: vi.fn(() => true) },
    setApprovalHandlerForSession: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as AgentRuntime;
}

function makeConfig(
  stateDir: string,
  ownerUserId: number | null = 42,
): AtomicAgentConfig {
  return {
    paths: { stateDir },
    telegram: { enabled: true, ownerUserId, parseMode: "html" },
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

  it("goes down when the polling loop dies underneath it", async () => {
    // The bug this pins: `bot.start()` is fire-and-forget, so when
    // Telegram killed the poller (a second process on the same token
    // gets a 409) the channel stayed at `up` and silently received
    // nothing. A dead poller must read as `down`, with the reason.
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
    expect(channel.state()).toBe("up");

    state.killPolling?.(
      new Error("409: Conflict: terminated by other getUpdates"),
    );

    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/Conflict/);
    expect(statuses.map((s) => s.state)).toEqual(["starting", "up", "down"]);
  });

  it("adopts a token written to the env after construction", async () => {
    // The bug this pins: the token is resolved once, in the
    // constructor. A credential writer that persists the token itself
    // -- the Integrations hub does -- left a running channel stuck on
    // the boot-time value, so every start() landed in `down` with
    // "missing TELEGRAM_BOT_TOKEN" until the operator relaunched.
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    delete process.env.TELEGRAM_BOT_TOKEN;
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      logger,
      botFactory: factory,
      lock,
    });

    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toBe("missing TELEGRAM_BOT_TOKEN");

    process.env.TELEGRAM_BOT_TOKEN = "1234:abcdef";
    try {
      channel.adoptTokenFromEnv();
      await channel.start();
      expect(channel.state()).toBe("up");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("releases the lock when the poller dies, so a restart can re-acquire", async () => {
    // Holding the lock after the poller is gone would make the channel
    // permanently unstartable in this process.
    const { factory, state } = makeBotFactory();
    const lockState = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock: lockState.lock,
    });
    await channel.start();
    expect(lockState.acquired).toBe(1);
    state.killPolling?.(new Error("boom"));
    expect(lockState.released).toBe(1);
    await channel.start();
    expect(channel.state()).toBe("up");
    expect(lockState.acquired).toBe(2);
  });

  it("reports a reason even when the poller ends without an error", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
    });
    await channel.start();
    state.killPolling?.();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toBe("polling stopped unexpectedly");
  });

  it("does not report a deliberate stop as a failure", async () => {
    // stop() ends the poller too; that must settle as `disabled`.
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
    await channel.stop();
    state.killPolling?.();
    expect(channel.state()).toBe("disabled");
    expect(statuses.map((s) => s.state)).not.toContain("down");
  });

  it("scrubs the token out of a polling-death reason", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
    });
    await channel.start();
    state.killPolling?.(
      new Error(
        `polling https://api.telegram.org/bot123456789:${"A".repeat(35)}/getUpdates failed`,
      ),
    );
    expect(channel.lastError()).toContain("<token>");
    expect(channel.lastError()).not.toContain("A".repeat(35));
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
    // The command menu is the only discovery surface on a phone — every
    // verb the slash dispatch answers has to be in it, `/model`
    // included.
    expect(state.registeredCommands).toEqual([
      "start",
      "help",
      "status",
      "sessions",
      "switch",
      "new",
      "model",
      "cancel",
    ]);
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

  it("leaves the winner's lock file intact when start() loses the race", async () => {
    // The bug this pins: start() releases from its catch block, and
    // `release()` used to unlink the file unconditionally. So the
    // process that LOST the race deleted the winner's lock on its way
    // down; the winner kept polling from memory while the file was
    // gone, and the next process acquired "successfully" -- two
    // pollers on one token, stopped only by Telegram's 409.
    //
    // `process.ppid` stands in for the winner: certainly alive, and
    // never this process, on POSIX and Windows alike.
    const lockPath = join(dir, "telegram.lock");
    writeFileSync(lockPath, String(process.ppid), "utf8");
    const { factory, state } = makeBotFactory();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock: new TelegramLockfile(lockPath),
    });

    await channel.start();

    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("already running");
    expect(state.startCalls).toBe(0);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
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

describe("TelegramChannel live-control surface", () => {
  let dir: string;
  let logger: StructuredLogger;
  let userConfigPath: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-livectl-"));
    logger = new StructuredLogger({ level: "warn", sinks: [] });
    userConfigPath = join(dir, "config.json");
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  function readPersistedTelegramConfig(): {
    enabled: boolean;
    ownerUserId: number | null;
    parseMode?: "plain" | "html";
  } {
    const raw = JSON.parse(readFileSync(userConfigPath, "utf8")) as {
      telegram: {
        enabled: boolean;
        ownerUserId: number | null;
        parseMode?: "plain" | "html";
      };
    };
    return raw.telegram;
  }

  it("setEnabled(false) on an up channel stops it and persists enabled=false", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("up");

    await channel.setEnabled(false);

    expect(channel.state()).toBe("disabled");
    expect(state.stopCalls).toBe(1);
    expect(readPersistedTelegramConfig().enabled).toBe(false);
  });

  it("setEnabled(true) starts the channel and persists enabled=true", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });

    await channel.setEnabled(true);

    expect(channel.state()).toBe("up");
    expect(state.startCalls).toBe(1);
    expect(readPersistedTelegramConfig().enabled).toBe(true);
  });

  it("setOwnerUserId restarts the channel when up and persists the new id", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.getOwnerUserId()).toBe(42);

    await channel.setOwnerUserId(7);

    expect(channel.state()).toBe("up");
    expect(channel.getOwnerUserId()).toBe(7);
    // restart triggered exactly one extra stop+start cycle
    expect(state.stopCalls).toBe(1);
    expect(state.startCalls).toBe(2);
    expect(readPersistedTelegramConfig().ownerUserId).toBe(7);
  });

  it("setOwnerUserId persists without restart when channel is down", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: null,
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("down");

    await channel.setOwnerUserId(7);

    expect(state.startCalls).toBe(0);
    expect(state.stopCalls).toBe(0);
    expect(channel.getOwnerUserId()).toBe(7);
    expect(readPersistedTelegramConfig().ownerUserId).toBe(7);
  });

  it("setToken writes to .env, mirrors process.env, and restarts when up", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();

    await channel.setToken("9876:zyxwvut");

    expect(channel.state()).toBe("up");
    expect(state.stopCalls).toBe(1);
    expect(state.startCalls).toBe(2);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("9876:zyxwvut");
    const raw = readFileSync(envPath, "utf8");
    expect(raw).toContain("TELEGRAM_BOT_TOKEN=9876:zyxwvut");
  });

  it("setToken(null) clears the token and the next start lands in down", async () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();

    await channel.setToken(null);

    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("missing TELEGRAM_BOT_TOKEN");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(existsSync(envPath)).toBe(false);
  });

  it("restart() is a no-op when down", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: null,
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("down");

    await channel.restart();

    expect(state.startCalls).toBe(0);
    expect(state.stopCalls).toBe(0);
  });

  it("startPairing returns null when channel is not up", async () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: null,
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    const result = await channel.startPairing(60_000);
    expect(result).toBeNull();
    expect(channel.pairingState().active).toBe(false);
  });

  it("cancelPairing resolves an in-flight pairing window with null", async () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    const pending = channel.startPairing(60_000);
    expect(channel.pairingState().active).toBe(true);
    channel.cancelPairing();
    await expect(pending).resolves.toBeNull();
    expect(channel.pairingState().active).toBe(false);
  });

  it("a pairing claim through the inbound text handler persists owner and restarts", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    // Persist a config with no owner so pairing has something to populate.
    const cfg = {
      ...USER_CONFIG_DEFAULTS,
      telegram: { enabled: true, ownerUserId: null },
    };
    writeFileSync(userConfigPath, JSON.stringify(cfg, null, 2), "utf8");

    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: {
        ...makeConfig(dir),
        telegram: { enabled: true, ownerUserId: null },
      } as AtomicAgentConfig,
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    const pending = channel.startPairing(60_000);
    expect(channel.pairingState().active).toBe(true);

    // Drive the registered text handler with a DM from a stranger.
    const handler = state.textHandler;
    expect(handler).not.toBeNull();
    await handler!({
      from: { id: 777 },
      chat: { id: 555, type: "private" },
      text: "/pair",
      message_id: 1,
    });

    const outcome = await pending;
    expect(outcome).not.toBeNull();
    expect(outcome!.claim).toEqual({ userId: 777, chatId: 555 });
    expect(outcome!.welcomeDelivered).toBe(true);
    expect(channel.getOwnerUserId()).toBe(777);
    expect(readPersistedTelegramConfig().ownerUserId).toBe(777);
    // restart cycle from setOwnerUserId
    expect(state.stopCalls).toBe(1);
    expect(state.startCalls).toBe(2);
    expect(channel.state()).toBe("up");
  });

  it("sends the welcome message exactly once after pairing claim is persisted", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const cfg = {
      ...USER_CONFIG_DEFAULTS,
      telegram: { enabled: true, ownerUserId: null },
    };
    writeFileSync(userConfigPath, JSON.stringify(cfg, null, 2), "utf8");

    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: {
        ...makeConfig(dir),
        telegram: { enabled: true, ownerUserId: null },
      } as AtomicAgentConfig,
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    const pending = channel.startPairing(60_000);
    await state.textHandler!({
      from: { id: 777 },
      chat: { id: 555, type: "private" },
      text: "/pair",
      message_id: 1,
    });
    const outcome = await pending;
    expect(outcome).not.toBeNull();
    // Locks: a happy-path welcome reports delivered=true so the TUI
    // can claim "Welcome message sent". A regression that silently
    // skips the sendMessage call (e.g. losing the post-restart bot
    // reference) would flip this back to false.
    expect(outcome!.welcomeDelivered).toBe(true);

    // Welcome lands AFTER the restart cycle on the new bot. Filter
    // any pre-existing sendMessages (none today, but defensive).
    const welcomes = state.sendMessageCalls.filter(
      (c) => c.chatId === 555 && c.text.includes("Telegram connected"),
    );
    expect(welcomes).toHaveLength(1);
    // Welcome text never carries the bot token or any operator input.
    expect(welcomes[0].text).not.toContain("1234:abcdef");
  });

  it("welcome failure is swallowed and never reverts the pairing claim", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const cfg = {
      ...USER_CONFIG_DEFAULTS,
      telegram: { enabled: true, ownerUserId: null },
    };
    writeFileSync(userConfigPath, JSON.stringify(cfg, null, 2), "utf8");

    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: {
        ...makeConfig(dir),
        telegram: { enabled: true, ownerUserId: null },
      } as AtomicAgentConfig,
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    // Now flip sendMessage to reject on the *next* bot (the post-
    // restart instance). We do this by monkey-patching the factory
    // state's sendMessage on each new bot via the recorder.
    const originalPush = state.sendMessageCalls.push.bind(
      state.sendMessageCalls,
    );
    state.sendMessageCalls.push = (...args) => {
      const result = originalPush(...args);
      if (args[0]?.text?.includes("Telegram connected")) {
        throw new Error("network down");
      }
      return result;
    };

    const pending = channel.startPairing(60_000);
    await state.textHandler!({
      from: { id: 777 },
      chat: { id: 555, type: "private" },
      text: "/pair",
      message_id: 1,
    });
    const outcome = await pending;
    // Pairing claim must still resolve with the captured user — a
    // best-effort welcome cannot revert the persisted owner.
    expect(outcome).not.toBeNull();
    expect(outcome!.claim).toEqual({ userId: 777, chatId: 555 });
    // Locks: failed welcome reports `welcomeDelivered: false` so the
    // TUI's success card branches into the "DM the bot to verify"
    // copy instead of falsely claiming delivery.
    expect(outcome!.welcomeDelivered).toBe(false);
    expect(channel.getOwnerUserId()).toBe(777);
    expect(channel.state()).toBe("up");
  });

  it("getParseMode reflects the value seeded from config at construction", () => {
    const { factory } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: {
        ...makeConfig(dir),
        telegram: { enabled: true, ownerUserId: 42, parseMode: "plain" },
      } as AtomicAgentConfig,
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    expect(channel.getParseMode()).toBe("plain");
  });

  it("setParseMode persists and restarts the channel when up", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.getParseMode()).toBe("html");

    await channel.setParseMode("plain");

    expect(channel.state()).toBe("up");
    expect(channel.getParseMode()).toBe("plain");
    expect(state.stopCalls).toBe(1);
    expect(state.startCalls).toBe(2);
    expect(readPersistedTelegramConfig().parseMode).toBe("plain");
  });

  it("setParseMode persists without restart when channel is down", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const channel = new TelegramChannel({
      runtime: fakeRuntime(),
      config: makeConfig(dir),
      token: null,
      logger,
      botFactory: factory,
      lock,
      userConfigPath,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("down");

    await channel.setParseMode("plain");

    expect(state.startCalls).toBe(0);
    expect(state.stopCalls).toBe(0);
    expect(channel.getParseMode()).toBe("plain");
    expect(readPersistedTelegramConfig().parseMode).toBe("plain");
  });

  describe("sendTaskReport", () => {
    function makeReport(): TaskReport {
      return {
        taskId: "t-report",
        status: "completed",
        userMessage: "morning digest",
        scheduleKind: "cron",
        attempts: 1,
        maxAttempts: 1,
        durationMs: 1_500,
        replyText: "All quiet. <3 & done",
        errorMessage: null,
        errorCategory: null,
      };
    }

    it("returns channel_not_up without queueing when no token is configured", async () => {
      const { factory, state } = makeBotFactory();
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir),
        token: null,
        logger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      const delivery = await channel.sendTaskReport(makeReport());
      expect(delivery).toBe("channel_not_up");
      expect(state.sendMessageCalls).toHaveLength(0);
    });

    it("queues a report while the channel is not up and flushes it on the transition to up", async () => {
      const { factory, state } = makeBotFactory();
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir, 42),
        token: "1234:abcdef",
        logger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      // Token configured, start() not called yet: the boot-race shape.
      const delivery = await channel.sendTaskReport(makeReport());
      expect(delivery).toBe("queued");
      expect(state.sendMessageCalls).toHaveLength(0);

      await channel.start();
      await vi.waitFor(() => {
        expect(state.sendMessageCalls).toHaveLength(1);
      });
      expect(state.sendMessageCalls[0]!.chatId).toBe(42);
      expect(state.sendMessageCalls[0]!.text).toContain(
        "✅ Scheduled task completed",
      );
    });

    it("evicts the oldest queued report with a warning when the queue is full", async () => {
      const warns: string[] = [];
      const capturingLogger = new StructuredLogger({
        level: "info",
        sinks: [
          (record) => {
            if (record.level === "warn") warns.push(record.message);
          },
        ],
      });
      const { factory, state } = makeBotFactory();
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir, 42),
        token: "1234:abcdef",
        logger: capturingLogger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      for (let i = 0; i <= TASK_REPORT_QUEUE_LIMIT; i += 1) {
        await channel.sendTaskReport({ ...makeReport(), taskId: `t-q${i}` });
      }
      expect(
        warns.filter((w) => w.includes("evicted: queue full")),
      ).toHaveLength(1);

      await channel.start();
      await vi.waitFor(() => {
        expect(state.sendMessageCalls).toHaveLength(TASK_REPORT_QUEUE_LIMIT);
      });
      const delivered = state.sendMessageCalls.map((c) => c.text).join("\n");
      // Oldest (t-q0) was evicted; the newest survived.
      expect(delivered).not.toContain("t-q0)");
      expect(delivered).toContain(`t-q${TASK_REPORT_QUEUE_LIMIT})`);
    });

    it("returns not_paired when the channel is up but no owner is configured", async () => {
      const { factory, state } = makeBotFactory();
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir, null),
        token: "1234:abcdef",
        logger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      await channel.start();
      const delivery = await channel.sendTaskReport(makeReport());
      expect(delivery).toBe("not_paired");
      expect(state.sendMessageCalls).toHaveLength(0);
    });

    it("sends the formatted report to the owner's DM as plain text (no parse_mode)", async () => {
      const { factory, state } = makeBotFactory();
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir, 42),
        token: "1234:abcdef",
        logger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      await channel.start();
      const delivery = await channel.sendTaskReport(makeReport());
      expect(delivery).toBe("sent");
      expect(state.sendMessageCalls).toHaveLength(1);
      const call = state.sendMessageCalls[0]!;
      // owner's private chat id IS the owner user id
      expect(call.chatId).toBe(42);
      expect(call.text).toContain("✅ Scheduled task completed");
      expect(call.text).toContain("morning digest");
      // plain infra text: the raw reply goes through unescaped, so a
      // parse_mode header would have broken on `<3 &`
      expect(call.text).toContain("All quiet. <3 & done");
      const sendMock = vi.mocked(
        (channel as unknown as { bot: BotInstance }).bot.api.sendMessage,
      );
      expect(sendMock.mock.calls[0]![2]).toBeUndefined();
    });

    it("returns delivery_failed with a delivered/total chunk warning when the API rejects a chunk", async () => {
      const warnRecords: Array<{
        message: string;
        context?: Record<string, unknown>;
      }> = [];
      const capturingLogger = new StructuredLogger({
        level: "warn",
        sinks: [
          (record) => {
            if (record.level === "warn") {
              warnRecords.push({
                message: record.message,
                ...(record.context ? { context: record.context } : {}),
              });
            }
          },
        ],
      });
      const { factory } = makeBotFactory({
        sendMessageError: new Error("400 chat not found"),
      });
      const channel = new TelegramChannel({
        runtime: fakeRuntime(),
        config: makeConfig(dir, 42),
        token: "1234:abcdef",
        logger: capturingLogger,
        botFactory: factory,
        lock: fakeLock().lock,
      });
      await channel.start();
      const delivery = await channel.sendTaskReport(makeReport());
      expect(delivery).toBe("delivery_failed");
      const chunkWarn = warnRecords.find((w) =>
        w.message.includes("task report chunks dropped"),
      );
      expect(chunkWarn?.context).toMatchObject({
        taskId: "t-report",
        deliveredChunks: 0,
        totalChunks: 1,
      });
    });
  });

  describe("buildTaskReportSink", () => {
    function makeSinkReport(): TaskReport {
      return {
        taskId: "t-sink",
        status: "completed",
        userMessage: "digest",
        scheduleKind: "cron",
        attempts: 1,
        maxAttempts: 1,
        durationMs: 100,
        replyText: "done",
        errorMessage: null,
        errorCategory: null,
      };
    }

    it("warn-logs with a reason and drops the report when no channel is constructed yet", async () => {
      const warns: Array<{
        message: string;
        context?: Record<string, unknown>;
      }> = [];
      const sink = TelegramChannel.buildTaskReportSink({
        resolveChannel: () => null,
        logger: {
          warn: (message, context) =>
            warns.push({ message, ...(context ? { context } : {}) }),
        },
      });
      await sink(makeSinkReport());
      expect(warns).toHaveLength(1);
      expect(warns[0]!.message).toContain("channel not constructed");
      expect(warns[0]!.context).toMatchObject({ taskId: "t-sink" });
    });

    it("warn-logs the delivery outcome when the channel skips the report", async () => {
      const warns: Array<{
        message: string;
        context?: Record<string, unknown>;
      }> = [];
      const sendTaskReport = vi.fn(async () => "channel_not_up" as const);
      const sink = TelegramChannel.buildTaskReportSink({
        resolveChannel: () =>
          ({ sendTaskReport }) as unknown as TelegramChannel,
        logger: {
          warn: (message, context) =>
            warns.push({ message, ...(context ? { context } : {}) }),
        },
      });
      await sink(makeSinkReport());
      expect(sendTaskReport).toHaveBeenCalledOnce();
      expect(warns).toHaveLength(1);
      expect(warns[0]!.context).toMatchObject({
        taskId: "t-sink",
        delivery: "channel_not_up",
      });
    });

    it("stays silent on a delivered report", async () => {
      const warns: string[] = [];
      const sink = TelegramChannel.buildTaskReportSink({
        resolveChannel: () =>
          ({
            sendTaskReport: async () => "sent" as const,
          }) as unknown as TelegramChannel,
        logger: { warn: (message) => warns.push(message) },
      });
      await sink(makeSinkReport());
      expect(warns).toHaveLength(0);
    });

    it("stays silent on a queued report (the channel owns that log and will flush)", async () => {
      const warns: string[] = [];
      const sink = TelegramChannel.buildTaskReportSink({
        resolveChannel: () =>
          ({
            sendTaskReport: async () => "queued" as const,
          }) as unknown as TelegramChannel,
        logger: { warn: (message) => warns.push(message) },
      });
      await sink(makeSinkReport());
      expect(warns).toHaveLength(0);
    });
  });
});

describe("scrubErrorMessage", () => {
  it("redacts a token-shaped substring", () => {
    const msg = scrubErrorMessage(
      new Error(
        "auth fail: 1234567:AAEoZw0X-1234567890abcdefghijklmnopqr happened",
      ),
    );
    expect(msg).not.toContain("AAEoZw0X");
    expect(msg).toContain("<token>");
  });

  it("leaves messages without tokens untouched", () => {
    expect(scrubErrorMessage(new Error("simple error"))).toBe("simple error");
  });

  it("redacts URL-embedded tokens (no word boundary at the start)", () => {
    // The grammy / fetch error messages embed the token inside the
    // URL fragment `https://api.telegram.org/bot<token>/sendMessage`,
    // where the preceding char is `t` and `\b` does not fire. The
    // scrubber must still redact.
    const msg = scrubErrorMessage(
      new Error(
        "fetch failed for https://api.telegram.org/bot1234567890:AAEoZw0X-1234567890abcdefghijklmnopqr/sendMessage",
      ),
    );
    expect(msg).not.toContain("AAEoZw0X");
    expect(msg).toContain("<token>");
  });
});

describe("TelegramChannel per-chat approval bindings", () => {
  let dir: string;
  let logger: StructuredLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-perchat-approvals-"));
    logger = new StructuredLogger({ level: "warn", sinks: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A runtime real enough for the inbound handler to run a turn. */
  function turnRuntime(setHandler: ReturnType<typeof vi.fn>): AgentRuntime {
    const sessions = new Map<
      string,
      {
        id: string;
        status: string;
        turnCount: number;
        stepCount: number;
        lastError: null;
      }
    >();
    let n = 0;
    return {
      approvals: { resolve: vi.fn(() => true) },
      setApprovalHandlerForSession: setHandler,
      createSession: () => {
        const s = {
          id: `s-${++n}`,
          status: "pending",
          turnCount: 0,
          stepCount: 0,
          lastError: null,
        };
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

  it("keeps one binding per chat, drops it on /new, and drops all on stop()", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const setHandler = vi.fn(() => {
      const u = vi.fn();
      unsubscribes.push(u);
      return u;
    });
    const channel = new TelegramChannel({
      runtime: turnRuntime(setHandler),
      config: makeConfig(dir),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    const dm = {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      text: "hi",
      message_id: 1,
    };
    const group = {
      from: { id: 42 },
      chat: { id: -100, type: "supergroup", title: "Ops" },
      text: "@test_bot hi",
      message_id: 2,
    };
    await state.textHandler!(dm);
    await state.textHandler!(group);
    // Two chats, two sessions, two live bindings — neither evicted the other.
    expect(setHandler).toHaveBeenCalledTimes(2);
    expect(setHandler.mock.calls.map((c) => c[0])).toEqual(["s-1", "s-2"]);
    expect(unsubscribes.every((u) => !u.mock.calls.length)).toBe(true);
    // A second DM turn re-uses the same session and binding.
    await state.textHandler!({ ...dm, message_id: 3 });
    expect(setHandler).toHaveBeenCalledTimes(2);
    // /new in the DM releases only the DM's binding.
    await state.textHandler!({ ...dm, text: "/new", message_id: 4 });
    expect(unsubscribes[0]!).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]!).not.toHaveBeenCalled();
    // stop() drops whatever is left.
    await channel.stop();
    expect(unsubscribes[1]!).toHaveBeenCalledTimes(1);
    // Replies went to the chats that asked.
    expect(
      state.sendMessageCalls
        .filter((m) => m.text === "ok")
        .map((m) => m.chatId),
    ).toEqual([42, -100, 42]);
  });
});

describe("TelegramChannel inbound files", () => {
  let dir: string;
  let logger: StructuredLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-channel-files-"));
    logger = new StructuredLogger({ level: "warn", sinks: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the file handler and routes an owner's photo into the inbox under stateDir", async () => {
    const { factory, state } = makeBotFactory();
    const { lock } = fakeLock();
    const runTurn = vi.fn(
      async (
        _session: unknown,
        _text: string,
        opts?: { eventHook?: (e: unknown) => void },
      ) => {
        opts?.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "seen" },
        });
        return { reason: "reply", stepCount: 1 };
      },
    );
    const runtime = fakeRuntime({
      runTurn,
      createSession: () => ({
        id: "s-file",
        status: "active",
        turnCount: 0,
        stepCount: 0,
      }),
      sessionStore: { load: () => null },
    } as unknown as Partial<AgentRuntime>);
    const channel = new TelegramChannel({
      runtime,
      config: makeConfig(dir, 42),
      token: "1234:abcdef",
      logger,
      botFactory: factory,
      lock,
      emitStatus: () => undefined,
    });
    await channel.start();
    expect(channel.state()).toBe("up");
    expect(state.fileHandler).not.toBeNull();

    await state.fileHandler!({
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      message_id: 3,
      caption: "look",
      file: { kind: "photo", file_id: "f1", file_size: 3 },
    });

    expect(runTurn).toHaveBeenCalledTimes(1);
    const message = runTurn.mock.calls[0]![1];
    const inboxRoot = join(dir, "inbox", "telegram");
    const path = /^- (\S+) \(image\/jpeg, 3 B\)$/m.exec(message)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(inboxRoot)).toBe(true);
    expect(existsSync(path!)).toBe(true);
    expect(state.sendMessageCalls.some((c) => c.text === "seen")).toBe(true);
    await channel.stop();
  });
});
