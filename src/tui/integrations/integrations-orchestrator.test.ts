import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import {
  TelegramChannel,
  type BotFactory,
  type BotInstance,
  type ChannelLock,
} from "../../channels/telegram/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { TuiTelegramOrchestrator } from "../telegram/tui-telegram-orchestrator.js";

import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";

const TOKEN = "1234567:abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * The hub drives *live* channels, so these tests use the real
 * `TelegramChannel` behind a fake bot factory rather than a mocked
 * orchestrator: the property under test is "did the running channel
 * actually come up", which a mock cannot answer.
 */
function makeBotFactory(opts: { getMeError?: Error } = {}): BotFactory {
  return () => {
    const bot: BotInstance = {
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        editMessageText: vi.fn(async () => undefined),
        answerCallbackQuery: vi.fn(async () => undefined),
        getMe: vi.fn(async () => {
          if (opts.getMeError) throw opts.getMeError;
          return { id: 1, username: "test_bot" };
        }),
        setMyCommands: vi.fn(async () => undefined),
      },
      setTextHandler: vi.fn(),
      setCallbackHandler: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    return bot;
  };
}

function fakeLock(): ChannelLock {
  return { acquire: vi.fn(), release: vi.fn() };
}

function makeBus(): {
  emit: (action: unknown) => void;
  subscribe: (l: (action: unknown) => void) => () => void;
  actions: Array<{ type: string } & Record<string, unknown>>;
} {
  const actions: Array<{ type: string } & Record<string, unknown>> = [];
  return {
    emit(action: unknown) {
      actions.push(action as { type: string } & Record<string, unknown>);
    },
    subscribe() {
      return () => {};
    },
    actions,
  };
}

describe("IntegrationsOrchestrator — live channel controls", () => {
  let stateDir: string;
  let logger: StructuredLogger;

  function makeChannel(opts: { getMeError?: Error } = {}): TelegramChannel {
    return new TelegramChannel({
      runtime: {
        approvals: { resolve: vi.fn(() => true) },
        setApprovalHandlerForSession: vi.fn(() => () => undefined),
      } as unknown as AgentRuntime,
      config: {
        paths: { stateDir },
        telegram: { enabled: false, ownerUserId: null, parseMode: "html" },
      } as unknown as AtomicAgentConfig,
      logger,
      botFactory: makeBotFactory(opts),
      lock: fakeLock(),
    });
  }

  function makeHub(channel: TelegramChannel | null): {
    hub: IntegrationsOrchestrator;
    bus: ReturnType<typeof makeBus>;
  } {
    const bus = makeBus();
    const runtime = {
      telegramChannel: channel,
      discordChannel: null,
      mcpManager: { listStatuses: () => [] },
    } as unknown as AgentRuntime;
    const telegram = new TuiTelegramOrchestrator(runtime, bus);
    const hub = new IntegrationsOrchestrator(runtime, bus, telegram);
    return { hub, bus };
  }

  function settled(bus: ReturnType<typeof makeBus>): {
    message?: string;
    error?: string;
  } {
    const events = bus.actions.filter(
      (a) => a.type === "integrations_action_settled",
    );
    return (events.at(-1) ?? {}) as { message?: string; error?: string };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "integrations-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfigCache();
    logger = new StructuredLogger({ level: "warn", sinks: [] });
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a token saved in the hub starts the running channel", async () => {
    // The bug this pins: the hub wrote `.env` itself and then called
    // `restart()`, which only re-starts a channel that was already
    // `up`. On a fresh install the channel was `disabled` and holding a
    // null token from construction, so the paste changed nothing in the
    // running process -- no poller, no pairing, until a relaunch.
    const channel = makeChannel();
    const { hub, bus } = makeHub(channel);

    await hub.saveField("telegram", "botToken", TOKEN);

    expect(channel.state()).toBe("up");
    expect(settled(bus).error).toBeUndefined();
  });

  it("clearing the token stops the channel", async () => {
    const channel = makeChannel();
    const { hub } = makeHub(channel);
    await hub.saveField("telegram", "botToken", TOKEN);
    expect(channel.state()).toBe("up");

    await hub.clearField("telegram", "botToken");

    expect(channel.state()).toBe("disabled");
  });

  it("pair brings the channel up first", async () => {
    // Pairing only claims a DM while the poller is running.
    const channel = makeChannel();
    const { hub } = makeHub(channel);
    await hub.saveField("telegram", "botToken", TOKEN);
    await channel.setEnabled(false);
    expect(channel.state()).toBe("disabled");

    await hub.runAction("telegram", "pair");

    expect(channel.state()).toBe("up");
  });

  it("pair reports the channel's own reason instead of announcing a window", async () => {
    // "DM your bot now" in front of a channel that never came up is
    // exactly the trap: the operator messages a bot nothing is
    // listening to and has no way to tell.
    const channel = makeChannel({ getMeError: new Error("401: Unauthorized") });
    const { hub, bus } = makeHub(channel);
    await hub.saveField("telegram", "botToken", TOKEN);
    expect(channel.state()).toBe("down");

    await hub.runAction("telegram", "pair");

    const last = settled(bus);
    expect(last.error).toMatch(/Unauthorized/);
    expect(last.message).toBeUndefined();
  });

  it("the Channel toggle starts and stops the live channel", async () => {
    const channel = makeChannel();
    const { hub } = makeHub(channel);
    await hub.saveField("telegram", "botToken", TOKEN);

    await hub.toggleField("telegram", "enabled");
    expect(channel.state()).toBe("disabled");

    await hub.toggleField("telegram", "enabled");
    expect(channel.state()).toBe("up");
  });

  it("a missing channel surfaces as an error, not a silent no-op", async () => {
    const { hub, bus } = makeHub(null);

    await hub.runAction("telegram", "pair");

    expect(settled(bus).error).toMatch(/unavailable/i);
  });
});
