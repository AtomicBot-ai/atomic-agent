import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "../bootstrap.js";
import type { AgentRuntime, CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../../config/index.js";
import { ApprovalRouter } from "../../approval/approval-router.js";
import { TelegramChannel, type BotFactory } from "../../channels/telegram/index.js";
import { DiscordChannel } from "../../channels/discord/index.js";
import { DiscordLockfile } from "../../channels/discord/discord-lockfile.js";
import { SwarmRegistry } from "../../channels/swarm/index.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { connectRuntimeChannels } from "./runtime-channels.js";
import { createRuntimeTaskRunner } from "./runtime-task-services.js";
import { ToolRegistry } from "../../tools/tool-registry.js";

const unexpected = (): never => { throw new Error("No external operation in channel composition tests"); };
const browser: BrowserBackend = {
  ensureReady: async () => unexpected(), shutdown: async () => {}, snapshot: async () => unexpected(),
  hasRef: async () => unexpected(), navigate: async () => unexpected(), click: async () => unexpected(),
  type: async () => unexpected(), search: async () => unexpected(), tabs: async () => unexpected(), scroll: async () => unexpected(),
};
const metrics = new AgentMetrics(new MetricsCollector({ sinks: [] }));
const logs: LogRecord[] = [];
const logger = new StructuredLogger({ level: "debug", sinks: [(record) => logs.push(record)] });
let dir: string;
let runtime: AgentRuntime;
let previous: Map<string, string | undefined>;
let connectedTelegram: TelegramChannel[];
let connectedDiscord: DiscordChannel[];
let connectedSwarm: SwarmRegistry[];

beforeEach(async () => {
  connectedTelegram = []; connectedDiscord = []; connectedSwarm = []; previous = new Map();
  dir = mkdtempSync(join(tmpdir(), "atomic-channels-composition-"));
  const workingDir = join(dir, "work"); mkdirSync(join(workingDir, ".atomic-agent/skills"), { recursive: true });
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.telegram.enabled = false; config.discord.enabled = false; config.swarm.units = [];
  config.analytics.enabled = false;
  config.memory.embeddings.enabled = false; config.localModels.embeddings.enabled = false;
  config.memory.consolidation.enabled = false; config.vision.enabled = false;
  config.web.search.provider = "duckduckgo"; config.web.search.persistCache = false;
  config.mcp.servers = [];
  writeUserConfigFileSync(join(dir, "config.json"), config);
  previous = new Map();
  for (const key of Object.keys(process.env)) if (key.startsWith("ATOMIC_AGENT_") || key === "TELEGRAM_BOT_TOKEN" || key === "DISCORD_BOT_TOKEN" || key === "GITHUB_TOKEN") { previous.set(key, process.env[key]); delete process.env[key]; }
  for (const [key, value] of Object.entries({ ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_GRAMMARS_DIR: join(process.cwd(), "grammars"), ATOMIC_AGENT_BROWSER_ENABLED: "false", ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED: "false", ATOMIC_AGENT_TASKS_RUN_ON_CREATE: "false" })) { if (!previous.has(key)) previous.set(key, process.env[key]); process.env[key] = value; }
  for (const key of ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]) if (!previous.has(key)) previous.set(key, undefined);
  resetConfigCache();
  runtime = await createAgentRuntime({ workingDir, approvalLevel: 5, overrides: { browserBackend: browser, skipLlamaHealthCheck: true, llamaComplete: async () => unexpected() } });
  connectedTelegram = []; connectedDiscord = []; connectedSwarm = []; logs.length = 0;
});
afterEach(async () => {
  // The test replays composition on a real façade; stop every new channel as well as bootstrap's original owned set.
  for (const channel of connectedTelegram) await channel.stop();
  for (const channel of connectedDiscord) await channel.stop();
  for (const swarm of connectedSwarm) await swarm.stopAll();
  if (runtime) await runtime.shutdown(); vi.restoreAllMocks();
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});
function args(options: Pick<CreateAgentRuntimeOptions, "handlers" | "overrides"> = {}) {
  return {
    runtime, config: runtime.config, logger, metrics, approvals: runtime.approvals,
    approvalRouter: new ApprovalRouter(() => {}), options,
    connectTelegram: (channel: TelegramChannel) => { expect(runtime.telegramChannel).toBe(channel); connectedTelegram.push(channel); },
    connectDiscord: (channel: DiscordChannel) => { expect(runtime.discordChannel).toBe(channel); connectedDiscord.push(channel); },
    connectSwarm: (swarm: SwarmRegistry) => { expect(runtime.swarm).toBe(swarm); connectedSwarm.push(swarm); },
  };
}

describe("runtime channel connection phases", () => {
  it("always constructs all three owners and connects each façade field before its start", () => {
    const order: string[] = [];
    runtime.config.telegram.enabled = true; runtime.config.discord.enabled = true;
    const telegram = vi.spyOn(TelegramChannel.prototype, "start").mockImplementation(async function(this: TelegramChannel) { expect(connectedTelegram.at(-1)).toBe(this); order.push("telegram:start"); });
    const discord = vi.spyOn(DiscordChannel.prototype, "start").mockImplementation(async function(this: DiscordChannel) { expect(connectedDiscord.at(-1)).toBe(this); order.push("discord:start"); });
    const swarm = vi.spyOn(SwarmRegistry.prototype, "startEnabled").mockImplementation(async function(this: SwarmRegistry) { expect(connectedSwarm.at(-1)).toBe(this); order.push("swarm:start"); });
    const deps = args();
    connectRuntimeChannels({ ...deps, connectTelegram: (channel) => { deps.connectTelegram(channel); order.push("telegram:connect"); }, connectDiscord: (channel) => { deps.connectDiscord(channel); order.push("discord:connect"); }, connectSwarm: (registry) => { deps.connectSwarm(registry); order.push("swarm:connect"); } });
    expect(order).toEqual(["telegram:connect", "telegram:start", "discord:connect", "discord:start", "swarm:connect", "swarm:start"]);
    expect(telegram).toHaveBeenCalledTimes(1); expect(discord).toHaveBeenCalledTimes(1); expect(swarm).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled primary channels present while still asking swarm to start its own enabled units", () => {
    const telegram = vi.spyOn(TelegramChannel.prototype, "start"); const discord = vi.spyOn(DiscordChannel.prototype, "start");
    const swarm = vi.spyOn(SwarmRegistry.prototype, "startEnabled").mockResolvedValue();
    connectRuntimeChannels(args());
    expect(connectedTelegram).toHaveLength(1); expect(connectedDiscord).toHaveLength(1); expect(connectedSwarm).toHaveLength(1);
    expect(telegram).not.toHaveBeenCalled(); expect(discord).not.toHaveBeenCalled(); expect(swarm).toHaveBeenCalledTimes(1);
  });

  it("does not await starts and logs rejected primary starts with the original error projection", async () => {
    runtime.config.telegram.enabled = true; runtime.config.discord.enabled = true;
    vi.spyOn(TelegramChannel.prototype, "start").mockRejectedValue(new Error("telegram rejected"));
    vi.spyOn(DiscordChannel.prototype, "start").mockRejectedValue("discord rejected");
    let release!: () => void;
    vi.spyOn(SwarmRegistry.prototype, "startEnabled").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    expect(connectRuntimeChannels(args())).toBeUndefined();
    await Promise.resolve();
    expect(logs.filter((record) => record.level === "error")).toMatchObject([
      { message: "telegram: start() rejected unexpectedly", context: { error: "telegram rejected" } },
      { message: "discord: start() rejected unexpectedly", context: { error: "discord rejected" } },
    ]);
    expect(connectedSwarm).toHaveLength(1); release();
  });

  it("keeps earlier shutdown references visible if later constructor arguments fail, without adding rollback", () => {
    const boom = new Error("discord configuration getter failed");
    const original = runtime.config.discord.ownerUserIds;
    Object.defineProperty(runtime.config.discord, "ownerUserIds", { configurable: true, get: () => { throw boom; } });
    try {
      expect(() => connectRuntimeChannels(args())).toThrow(boom);
      expect(connectedTelegram).toHaveLength(1); expect(connectedDiscord).toEqual([]); expect(connectedSwarm).toEqual([]);
      expect(runtime.telegramChannel).toBe(connectedTelegram[0]);
    } finally { Object.defineProperty(runtime.config.discord, "ownerUserIds", { configurable: true, writable: true, value: original }); }
  });

  it("retains the original options object, repeated factory property reads and late status handler lookup", async () => {
    let reads = 0;
    const botFactory: BotFactory = () => unexpected();
    const options: Pick<CreateAgentRuntimeOptions, "handlers" | "overrides"> = { overrides: { get telegramBotFactory() { reads++; return botFactory; } } };
    connectRuntimeChannels(args(options));
    expect(reads).toBe(4); // condition + selected property for primary and swarm.
    const statuses: string[] = [];
    options.handlers = { onChannelStatus: (status) => statuses.push(status.channel) };
    await connectedTelegram[0]?.start();
    // Discord suppresses repeated disabled status; provoke a real pre-network lock failure instead.
    process.env.DISCORD_BOT_TOKEN = "test-token";
    vi.spyOn(DiscordLockfile.prototype, "acquire").mockImplementation(() => { throw new Error("fixture lock conflict"); });
    await connectedDiscord[0]?.setEnabled(true);
    expect(statuses).toEqual(["telegram", "discord", "discord"]);
    expect(connectedTelegram[0]?.hasToken()).toBe(false);
  });

  it("resolves task report delivery against the newly connected channel rather than the construction-time null", async () => {
    let channel: TelegramChannel | null = null;
    const send = vi.spyOn(TelegramChannel.prototype, "sendTaskReport").mockResolvedValue("sent");
    const runner = createRuntimeTaskRunner({ config: runtime.config, taskStore: runtime.taskStore, runTurn: async (session) => ({ session, reason: "reply", stepCount: 1 }), sessionStore: runtime.sessionStore, createSession: (input) => runtime.createSession(input), toolRegistry: new ToolRegistry(), resolveTelegram: () => channel, logger, metrics });
    const first = runner.create({ userMessage: "early", origin: "cli", maxAttempts: 1, notify: "telegram" });
    await runner.runOne(first.id); await Promise.resolve(); expect(send).not.toHaveBeenCalled();
    const deps = args(); connectRuntimeChannels({ ...deps, connectTelegram: (next) => { deps.connectTelegram(next); channel = next; } });
    const second = runner.create({ userMessage: "after channel", origin: "cli", maxAttempts: 1, notify: "telegram" });
    await runner.runOne(second.id); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.instances[0]).toBe(channel);
    expect(runtime.taskStore.get(first.id)?.status).toBe("completed"); expect(runtime.taskStore.get(second.id)?.status).toBe("completed");
  });
});
