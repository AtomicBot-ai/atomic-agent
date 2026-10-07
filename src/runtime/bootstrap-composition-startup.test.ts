import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "./bootstrap.js";
import type { AgentRuntime } from "./runtime-contract.js";
import { resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../config/index.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { ShellJobRegistry } from "../tools/os/shell/shell-jobs.js";
import { SessionStore } from "../session/session-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { MemoryStore } from "../memory/memory-store.js";
import { LessonStore } from "../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../memory/procedures/procedure-store.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { ConsolidatorJob } from "../memory/consolidator/consolidator-job.js";
import * as observability from "./composition/runtime-observability.js";
import * as localProfile from "./composition/runtime-local-profile.js";
import * as inference from "./composition/runtime-inference.js";
import * as skills from "./composition/runtime-skills.js";
import * as memoryStores from "./composition/runtime-memory-stores.js";
import * as memoryServices from "./composition/runtime-memory-services.js";
import * as sessions from "./composition/runtime-session-services.js";
import * as tools from "./composition/runtime-tool-catalog.js";
import * as tasks from "./composition/runtime-task-services.js";
import * as channels from "./composition/runtime-channels.js";

const unexpected = (): never => { throw new Error("No external operation in startup composition tests"); };
let dir: string;
let previous: Map<string, string | undefined>;
let runtime: AgentRuntime | undefined;
let acquiredMemory: memoryStores.RuntimeMemoryStores | undefined;
let acquiredSessions: SessionStore | undefined;
let acquiredShell: ShellJobRegistry | undefined;
let acquiredManager: McpManager | undefined;
let acquiredTelemetry: ReturnType<typeof observability.createRuntimeObservability> | undefined;
let acquiredProviders: inference.RuntimeProviders | undefined;
let events: string[];
let browser: BrowserBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-startup-composition-"));
  mkdirSync(join(dir, "work", ".atomic-agent/skills"), { recursive: true });
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.analytics.enabled = false; config.telegram.enabled = false; config.discord.enabled = false; config.swarm.units = [];
  config.mcp.servers = [{ name: "fixture-disabled", enabled: false, transport: { kind: "stdio", command: "must-not-spawn" } }]; config.web.search.provider = "duckduckgo"; config.web.search.persistCache = false;
  config.memory.embeddings.enabled = false; config.localModels.embeddings.enabled = false;
  config.memory.consolidation.enabled = true; config.memory.consolidation.intervalMs = 3_600_000;
  config.memory.lessons.enabled = true; config.vision.enabled = false;
  writeUserConfigFileSync(join(dir, "config.json"), config);
  previous = new Map();
  for (const key of Object.keys(process.env)) if (key.startsWith("ATOMIC_AGENT_") || key === "TELEGRAM_BOT_TOKEN" || key === "DISCORD_BOT_TOKEN" || key === "GITHUB_TOKEN") { previous.set(key, process.env[key]); delete process.env[key]; }
  for (const [key, value] of Object.entries({ ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_GRAMMARS_DIR: join(process.cwd(), "grammars"), ATOMIC_AGENT_BROWSER_ENABLED: "false", ATOMIC_AGENT_TASKS_ENABLED: "true", ATOMIC_AGENT_TASKS_RUN_ON_CREATE: "false", ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED: "true", ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS: "3600000" })) { if (!previous.has(key)) previous.set(key, process.env[key]); process.env[key] = value; }
  resetConfigCache();
  runtime = undefined; acquiredMemory = undefined; acquiredSessions = undefined; acquiredShell = undefined;
  acquiredManager = undefined; acquiredTelemetry = undefined; acquiredProviders = undefined; events = [];
  browser = {
    ensureReady: async () => unexpected(), shutdown: vi.fn(async () => {}), snapshot: async () => unexpected(),
    hasRef: async () => unexpected(), navigate: async () => unexpected(), click: async () => unexpected(),
    type: async () => unexpected(), search: async () => unexpected(), tabs: async () => unexpected(), scroll: async () => unexpected(),
  };
});
afterEach(async () => {
  try {
    if (runtime) await runtime.shutdown();
    else {
      // Baseline has no whole-boot rollback. This test, rather than production, owns fault-fixture disposal.
      await acquiredManager?.shutdown(); await browser.shutdown(); acquiredShell?.endAll();
      acquiredSessions?.close(); acquiredMemory?.profileStore.close(); acquiredMemory?.lessonStore.close();
      acquiredMemory?.procedureStore.close(); acquiredMemory?.notesStore.close();
      await acquiredTelemetry?.getAnalytics()?.shutdown(); await acquiredTelemetry?.getErrorReporter()?.shutdown();
    }
    // Existing runtime shutdown does not iterate provider.close(); dispose acquired test providers explicitly.
    for (const id of acquiredProviders?.providerRegistry.listIds() ?? []) await acquiredProviders?.providerRegistry.getProvider(id)?.close();
  } finally {
    vi.restoreAllMocks();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetConfigCache(); rmSync(dir, { recursive: true, force: true });
  }
});
function observePhases() {
  const createTelemetry = observability.createRuntimeObservability;
  vi.spyOn(observability, "createRuntimeObservability").mockImplementation((...args) => { events.push("observability"); acquiredTelemetry = createTelemetry(...args); return acquiredTelemetry; });
  const prepareLocal = localProfile.prepareRuntimeLocalProfile;
  vi.spyOn(localProfile, "prepareRuntimeLocalProfile").mockImplementation(async (...args) => { events.push("local-profile"); return prepareLocal(...args); });
  const prepareSkills = skills.prepareRuntimeSkills;
  vi.spyOn(skills, "prepareRuntimeSkills").mockImplementation(async (...args) => { events.push("skills"); return prepareSkills(...args); });
  const createMemory = memoryStores.createRuntimeMemoryStores;
  vi.spyOn(memoryStores, "createRuntimeMemoryStores").mockImplementation(async (...args) => { events.push("memory-stores"); acquiredMemory = await createMemory(...args); return acquiredMemory; });
  const prepareSession = sessions.prepareRuntimeSessionStore;
  vi.spyOn(sessions, "prepareRuntimeSessionStore").mockImplementation((...args) => { events.push("session-store"); acquiredSessions = prepareSession(...args); return acquiredSessions; });
  const installDelete = sessions.installRuntimeSessionDelete;
  vi.spyOn(sessions, "installRuntimeSessionDelete").mockImplementation((...args) => { events.push("session-delete-hook"); return installDelete(...args); });
  const createTools = tools.createRuntimeToolRegistry;
  vi.spyOn(tools, "createRuntimeToolRegistry").mockImplementation((...args) => { events.push("terminal-browser-tools"); return createTools(...args); });
  const registerCore = tools.registerRuntimeCoreTools;
  vi.spyOn(tools, "registerRuntimeCoreTools").mockImplementation((...args) => { events.push("core-tools"); acquiredShell = args[0].shellJobs; return registerCore(...args); });
  const connectLocal = localProfile.connectRuntimeLocalProfile;
  vi.spyOn(localProfile, "connectRuntimeLocalProfile").mockImplementation(async (...args) => { events.push("local-profile-connect"); return connectLocal(...args); });
  const connectProviders = inference.connectRuntimeProviders;
  vi.spyOn(inference, "connectRuntimeProviders").mockImplementation(async (...args) => { events.push("providers"); acquiredProviders = await connectProviders(...args); return acquiredProviders; });
  const registerVision = tools.registerRuntimeVisionTools;
  vi.spyOn(tools, "registerRuntimeVisionTools").mockImplementation((...args) => { events.push("vision-tools"); return registerVision(...args); });
  const connectMcp = tools.connectRuntimeMcpCatalog;
  vi.spyOn(tools, "connectRuntimeMcpCatalog").mockImplementation(async (...args) => { events.push("mcp-connect"); return connectMcp(...args); });
  const createTasks = tasks.createRuntimeTaskStores;
  const taskStores = vi.spyOn(tasks, "createRuntimeTaskStores").mockImplementation((...args) => { events.push("task-stores"); return createTasks(...args); });
  const createMemoryServices = memoryServices.createRuntimeMemoryServices;
  const memory = vi.spyOn(memoryServices, "createRuntimeMemoryServices").mockImplementation((...args) => { events.push("memory-services"); return createMemoryServices(...args); });
  const createRunner = tasks.createRuntimeTaskRunner;
  vi.spyOn(tasks, "createRuntimeTaskRunner").mockImplementation((...args) => { events.push("task-runner"); return createRunner(...args); });
  const registerFusion = tools.registerRuntimeFusionAndReadScope;
  vi.spyOn(tools, "registerRuntimeFusionAndReadScope").mockImplementation((...args) => { events.push("fusion-read-scope"); return registerFusion(...args); });
  const createScheduler = tasks.createRuntimeScheduler;
  const scheduler = vi.spyOn(tasks, "createRuntimeScheduler").mockImplementation((...args) => { events.push("scheduler-construct"); return createScheduler(...args); });
  const createConsolidator = memoryServices.createRuntimeMemoryConsolidator;
  vi.spyOn(memoryServices, "createRuntimeMemoryConsolidator").mockImplementation((...args) => { events.push("consolidator-construct"); return createConsolidator(...args); });
  const connectChannels = channels.connectRuntimeChannels;
  const channel = vi.spyOn(channels, "connectRuntimeChannels").mockImplementation((args) => {
    events.push("channels");
    connectChannels({ ...args,
      connectTelegram: (next) => { expect(args.runtime.telegramChannel).toBe(next); events.push("telegram-assigned"); args.connectTelegram(next); },
      connectDiscord: (next) => { expect(args.runtime.discordChannel).toBe(next); events.push("discord-assigned"); args.connectDiscord(next); },
      connectSwarm: (next) => { expect(args.runtime.swarm).toBe(next); events.push("swarm-assigned"); args.connectSwarm(next); },
    });
  });
  return { taskStores, memory, scheduler, channel };
}
const early = ["observability", "local-profile", "skills", "memory-stores", "session-store", "session-delete-hook", "terminal-browser-tools", "core-tools", "local-profile-connect", "providers", "vision-tools", "mcp-connect", "mcp-start"];
const boot = async () => { runtime = await createAgentRuntime({ workingDir: join(dir, "work"), approvalLevel: 5, overrides: { browserBackend: browser, skipLlamaHealthCheck: true, llamaComplete: async () => unexpected() } }); return runtime; };

describe("whole-runtime startup composition", () => {
  it("preserves an MCP start rejection after real stores open, without running later phases or inventing implicit cleanup", async () => {
    const phases = observePhases();
    const failure = new Error("injected MCP start rejection");
    vi.spyOn(McpManager.prototype, "start").mockImplementation(async function(this: McpManager) { acquiredManager = this; events.push("mcp-start"); throw failure; });
    const managerClose = vi.spyOn(McpManager.prototype, "shutdown");
    const sessionClose = vi.spyOn(SessionStore.prototype, "close");
    const profileClose = vi.spyOn(ProfileStore.prototype, "close"); const notesClose = vi.spyOn(MemoryStore.prototype, "close");
    const lessonClose = vi.spyOn(LessonStore.prototype, "close"); const procedureClose = vi.spyOn(ProcedureStore.prototype, "close");
    await expect(boot()).rejects.toBe(failure);
    expect(events).toEqual(early);
    expect(acquiredMemory).toBeDefined(); expect(acquiredSessions).toBeDefined(); expect(acquiredShell).toBeDefined(); expect(acquiredProviders).toBeDefined();
    expect(phases.taskStores).not.toHaveBeenCalled(); expect(phases.memory).not.toHaveBeenCalled(); expect(phases.scheduler).not.toHaveBeenCalled(); expect(phases.channel).not.toHaveBeenCalled();
    expect(managerClose).not.toHaveBeenCalled(); expect(browser.shutdown).not.toHaveBeenCalled();
    for (const close of [sessionClose, profileClose, notesClose, lessonClose, procedureClose]) expect(close).not.toHaveBeenCalled();
    expect(acquiredMemory?.notesStore.getDatabaseHandleForEmbeddings().open).toBe(true);
    acquiredMemory?.profileStore.set("fault-test", "still-open");
    expect(acquiredMemory?.lessonStore.countAll()).toBe(0); expect(acquiredMemory?.procedureStore.countAll()).toBe(0);
    const session = acquiredSessions?.listRecent(1); expect(session).toEqual([]);
  });

  it("keeps real consolidator start earlier and starts scheduler only after all channel fields and shutdown references connect", async () => {
    observePhases();
    const mcpStart = McpManager.prototype.start;
    vi.spyOn(McpManager.prototype, "start").mockImplementation(async function(this: McpManager) { acquiredManager = this; events.push("mcp-start"); return mcpStart.call(this); });
    const consolidatorStart = ConsolidatorJob.prototype.start;
    vi.spyOn(ConsolidatorJob.prototype, "start").mockImplementation(function(this: ConsolidatorJob) { events.push("consolidator-start"); return consolidatorStart.call(this); });
    const schedulerStart = Scheduler.prototype.start;
    vi.spyOn(Scheduler.prototype, "start").mockImplementation(function(this: Scheduler) {
      expect(events.slice(-3)).toEqual(["telegram-assigned", "discord-assigned", "swarm-assigned"]);
      events.push("scheduler-start"); return schedulerStart.call(this);
    });
    runtime = await boot();
    expect(events).toEqual([...early, "task-stores", "memory-services", "task-runner", "fusion-read-scope", "scheduler-construct", "consolidator-construct", "consolidator-start", "channels", "telegram-assigned", "discord-assigned", "swarm-assigned", "scheduler-start"]);
    expect(runtime.scheduler).not.toBeNull(); expect(runtime.telegramChannel).not.toBeNull(); expect(runtime.discordChannel).not.toBeNull(); expect(runtime.swarm).not.toBeNull();
  });
});
