import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicAgentConfig, SwarmUnitConfig } from "../../config/index.js";
import { readUserConfigFileSync, resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { BotFactory, BotInstance } from "../telegram/telegram-channel.js";
import { TelegramChannel } from "../telegram/telegram-channel.js";
import { SwarmRegistry } from "./swarm-registry.js";
import { slugForUnit, tokenEnvForUnit } from "./swarm-settings.js";

/** Fake grammy adapter: records starts, never touches the network. */
function makeBotFactory(): { factory: BotFactory; starts: string[]; stops: number } {
  const state = { starts: [] as string[], stops: 0 };
  const factory: BotFactory = (token) => {
    const bot: BotInstance = {
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        getMe: vi.fn(async () => ({ id: 7, username: `bot_${token.slice(0, 4)}` })),
        setMyCommands: vi.fn(async () => undefined),
      },
      setTextHandler() {},
      setCallbackHandler() {},
      start() {
        state.starts.push(token);
      },
      async stop() {
        state.stops += 1;
      },
    };
    return bot;
  };
  return { factory, get starts() { return state.starts; }, get stops() { return state.stops; } };
}

function makeConfig(stateDir: string, units: SwarmUnitConfig[] = []): AtomicAgentConfig {
  return {
    paths: { stateDir },
    telegram: { enabled: false, ownerUserId: null, parseMode: "plain", progressIndicator: true },
    discord: { enabled: false, ownerUserId: null },
    swarm: { units },
  } as unknown as AtomicAgentConfig;
}

const runtime = {
  approvals: { resolve: vi.fn(() => true) },
  setApprovalHandlerForSession: vi.fn(() => () => undefined),
} as unknown as AgentRuntime;

describe("SwarmRegistry", () => {
  let dir: string;
  let logger: StructuredLogger;
  const envKeys: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-swarm-"));
    logger = new StructuredLogger({ level: "warn", sinks: [] });
    resetConfigCache();
  });

  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
    envKeys.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function make(units: SwarmUnitConfig[] = []) {
    const bots = makeBotFactory();
    const registry = new SwarmRegistry({
      runtime,
      config: makeConfig(dir, units),
      logger,
      approvals: { resolve: vi.fn() } as never,
      approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
      stateDir: dir,
      userConfigFile: join(dir, "config.json"),
      telegramBotFactory: bots.factory,
    });
    return { registry, bots };
  }

  function persistedUnits(): SwarmUnitConfig[] {
    return readUserConfigFileSync(join(dir, "config.json"))?.swarm.units ?? [];
  }

  it("adds a Telegram bot: token to .env, unit to config, channel up", async () => {
    const { registry, bots } = make();
    const unit = await registry.add({ kind: "telegram", label: "Ops", role: "ops", token: "1234567:" + "a".repeat(35) });
    envKeys.push(unit.config.tokenEnv);
    expect(unit.config.id).toBe("ops");
    expect(unit.config.tokenEnv).toBe("TELEGRAM_BOT_TOKEN_OPS");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TELEGRAM_BOT_TOKEN_OPS=");
    expect(persistedUnits()).toEqual([
      {
        id: "ops",
        kind: "telegram",
        label: "Ops",
        role: "ops",
        enabled: true,
        tokenEnv: "TELEGRAM_BOT_TOKEN_OPS",
        ownerUserId: null,
      },
    ]);
    expect(bots.starts).toHaveLength(1);
    const [view] = registry.views();
    expect(view).toMatchObject({ id: "ops", kind: "telegram", hasToken: true, state: "up", role: "ops" });
    // The primary channel's own settings were not touched.
    expect(readUserConfigFileSync(join(dir, "config.json"))?.telegram.ownerUserId).toBeNull();
  });

  it("does not start a bot that has no token, and keeps ids unique", async () => {
    const { registry, bots } = make();
    const a = await registry.add({ kind: "telegram", label: "Ops" });
    const b = await registry.add({ kind: "telegram", label: "Ops" });
    expect([a.config.id, b.config.id]).toEqual(["ops", "ops-2"]);
    expect(bots.starts).toHaveLength(0);
    expect(registry.views().map((v) => v.hasToken)).toEqual([false, false]);
    expect(registry.views().map((v) => v.state)).toEqual(["disabled", "disabled"]);
  });

  it("a pairing claim persisted through the unit's sink lands on the unit, not on config.telegram", async () => {
    const { registry } = make();
    const unit = await registry.add({ kind: "telegram", label: "Ops", token: "1234567:" + "b".repeat(35) });
    envKeys.push(unit.config.tokenEnv);
    // This is what `handlePairingClaim` calls on the channel.
    await (unit.channel as TelegramChannel).setOwnerUserId(4242);
    expect(registry.get("ops")?.config.ownerUserId).toBe("4242");
    expect(persistedUnits()[0]?.ownerUserId).toBe("4242");
    expect(readUserConfigFileSync(join(dir, "config.json"))?.telegram.ownerUserId).toBeNull();
  });

  it("update changes label / role / owner and switching off stops the channel", async () => {
    const { registry, bots } = make();
    const unit = await registry.add({ kind: "telegram", label: "Ops", token: "1234567:" + "c".repeat(35) });
    envKeys.push(unit.config.tokenEnv);
    await registry.update("ops", { label: "Operations", role: "deploys", ownerUserId: "99" });
    expect(registry.get("ops")?.config).toMatchObject({ label: "Operations", role: "deploys", ownerUserId: "99" });
    await registry.update("ops", { enabled: false });
    expect(bots.stops).toBeGreaterThanOrEqual(1);
    expect(registry.views()[0]).toMatchObject({ enabled: false, state: "disabled" });
    expect(persistedUnits()[0]).toMatchObject({ label: "Operations", enabled: false });
  });

  it("setToken on a Telegram unit rewrites its own .env key", async () => {
    const { registry } = make();
    const unit = await registry.add({ kind: "telegram", label: "Ops", enabled: false });
    envKeys.push(unit.config.tokenEnv);
    await registry.setToken("ops", "7654321:" + "d".repeat(35));
    expect(process.env.TELEGRAM_BOT_TOKEN_OPS).toBe("7654321:" + "d".repeat(35));
    expect(registry.views()[0]?.hasToken).toBe(true);
    // The primary key is untouched.
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("remove stops the bot, forgets its token, config entry and session map", async () => {
    const { registry } = make();
    const unit = await registry.add({ kind: "telegram", label: "Ops", token: "1234567:" + "e".repeat(35) });
    envKeys.push(unit.config.tokenEnv);
    const pointer = join(dir, "telegram-session-ops.json");
    writeFileSync(pointer, JSON.stringify({ version: 2, chats: {} }));
    await registry.remove("ops");
    expect(registry.list()).toHaveLength(0);
    expect(persistedUnits()).toEqual([]);
    expect(process.env.TELEGRAM_BOT_TOKEN_OPS).toBeUndefined();
    const env = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "";
    expect(env).not.toContain("TELEGRAM_BOT_TOKEN_OPS");
    expect(existsSync(pointer)).toBe(false);
  });

  it("constructs every configured unit at boot and starts only the enabled ones with a token", async () => {
    process.env.TELEGRAM_BOT_TOKEN_A = "1234567:" + "f".repeat(35);
    envKeys.push("TELEGRAM_BOT_TOKEN_A");
    const units: SwarmUnitConfig[] = [
      { id: "a", kind: "telegram", label: "A", role: "", enabled: true, tokenEnv: "TELEGRAM_BOT_TOKEN_A", ownerUserId: "1" },
      { id: "b", kind: "telegram", label: "B", role: "", enabled: false, tokenEnv: "TELEGRAM_BOT_TOKEN_B", ownerUserId: null },
      { id: "c", kind: "discord", label: "C", role: "", enabled: true, tokenEnv: "DISCORD_BOT_TOKEN_C", ownerUserId: null },
    ];
    const { registry, bots } = make(units);
    expect(registry.list().map((u) => u.config.id)).toEqual(["a", "b", "c"]);
    await registry.startEnabled();
    // `a` has a token and is enabled; `b` is off; `c` (Discord) has no token → disabled, no network.
    expect(bots.starts).toHaveLength(1);
    expect(registry.views().map((v) => v.state)).toEqual(["up", "disabled", "disabled"]);
  });

  it("a Discord unit without a token is constructed but never starts, and setToken rebuilds it", async () => {
    const { registry } = make();
    const unit = await registry.add({ kind: "discord", label: "Guild bot", enabled: false });
    envKeys.push(unit.config.tokenEnv);
    expect(unit.config.tokenEnv).toBe("DISCORD_BOT_TOKEN_GUILD_BOT");
    expect(registry.views()[0]).toMatchObject({ kind: "discord", hasToken: false, state: "disabled" });
    const before = registry.get("guild-bot")!.channel;
    await registry.setToken("guild-bot", "a".repeat(24) + ".bbbbbb." + "c".repeat(30));
    // Discord fixes its token at construction, so the channel object is new.
    expect(registry.get("guild-bot")!.channel).not.toBe(before);
    expect(registry.views()[0]?.hasToken).toBe(true);
    expect(registry.views()[0]?.state).toBe("disabled"); // still switched off
  });

  it("notifies listeners on membership changes", async () => {
    const { registry } = make();
    const listener = vi.fn();
    registry.onChange(listener);
    const unit = await registry.add({ kind: "telegram", label: "Ops" });
    envKeys.push(unit.config.tokenEnv);
    await registry.remove("ops");
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("swarm settings helpers", () => {
  it("slugs labels and keeps them unique", () => {
    expect(slugForUnit("Ops Bot", new Set())).toBe("ops-bot");
    expect(slugForUnit("Ops Bot", new Set(["ops-bot"]))).toBe("ops-bot-2");
    expect(slugForUnit("!!!", new Set())).toBe("bot");
    expect(slugForUnit("Ёж", new Set())).toBe("bot");
  });

  it("derives an env key per kind and id", () => {
    expect(tokenEnvForUnit("telegram", "ops-bot")).toBe("TELEGRAM_BOT_TOKEN_OPS_BOT");
    expect(tokenEnvForUnit("discord", "guild-2")).toBe("DISCORD_BOT_TOKEN_GUILD_2");
  });
});
