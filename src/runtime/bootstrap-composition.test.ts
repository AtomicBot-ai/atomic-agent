import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./bootstrap.js";
import type { AgentRuntime } from "./runtime-contract.js";
import { resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../config/index.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { TraceEvent } from "../tracing/trace/index.js";
import { Scheduler } from "../scheduler/index.js";
import * as skills from "./composition/runtime-skills.js";
import * as tools from "./composition/runtime-tool-catalog.js";
import * as local from "./composition/runtime-local-profile.js";
import * as inference from "./composition/runtime-inference.js";
import * as sessions from "./composition/runtime-session-services.js";
import * as tasks from "./composition/runtime-task-services.js";
import * as channels from "./composition/runtime-channels.js";
import * as memory from "./composition/runtime-memory-services.js";
import * as seeding from "../skills/seed-starter-skills.js";
import * as composio from "../composio/index.js";
import { setDynamicResourceClassResolver } from "../agent/tool-resource-class.js";

const externalOperation = (): never => { throw new Error("Assembly fixture must not perform external work"); };
function browser(): BrowserBackend {
  return {
    ensureReady: async () => externalOperation(), shutdown: vi.fn(async () => {}), snapshot: async () => externalOperation(),
    hasRef: async () => externalOperation(), navigate: async () => externalOperation(), click: async () => externalOperation(),
    type: async () => externalOperation(), search: async () => externalOperation(), tabs: async () => externalOperation(), scroll: async () => externalOperation(),
  };
}
const completion = async (): Promise<CompletionResult> => ({
  content: JSON.stringify([{ tool: "reply", args: { text: "fixture response" } }]),
  reasoningContent: "", stop: true, truncated: false, cacheHitTokens: 0, slotId: 0, modelId: null,
  timing: { promptMs: 0, predictedMs: 0, promptTokens: 20, predictedTokens: 10 },
});

describe("complete runtime composition", () => {
  let directory: string;
  let workingDir: string;
  const runtimes: AgentRuntime[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "atomic-runtime-assembly-"));
    workingDir = join(directory, "work");
    await mkdir(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    for (const key of Object.keys(process.env)) if (key.startsWith("ATOMIC_AGENT_")) vi.stubEnv(key, undefined);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(directory, "state"));
    vi.stubEnv("ATOMIC_AGENT_GRAMMARS_DIR", join(process.cwd(), "grammars"));
    const config = structuredClone(USER_CONFIG_DEFAULTS);
    config.analytics.enabled = false; config.telegram.enabled = false; config.discord.enabled = false;
    config.memory.embeddings.enabled = false; config.localModels.embeddings.enabled = false;
    config.memory.reflection.enabled = false; config.memory.evolution.enabled = false;
    config.memory.consolidation.enabled = false; config.agent.nameSessions = false;
    config.web.search.provider = "duckduckgo"; config.web.search.persistCache = false;
    vi.stubEnv("ATOMIC_AGENT_TASKS_ENABLED", "true");
    vi.stubEnv("ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED", "true");
    vi.stubEnv("ATOMIC_AGENT_TASKS_RUN_ON_CREATE", "false");
    vi.stubEnv("ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS", "60000");
    config.mcp.servers = [];
    writeUserConfigFileSync(join(directory, "state", "config.json"), config);
    resetConfigCache();
    vi.spyOn(composio, "resolveComposioServerConfig").mockResolvedValue(undefined);
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockResolvedValue({ sourceDir: null, installed: [], removed: [] });
  });
  afterEach(async () => {
    try { for (const runtime of runtimes.splice(0)) await runtime.shutdown(); }
    finally { setDynamicResourceClassResolver(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache(); await rm(directory, { recursive: true, force: true }); }
  });
  async function boot(backend = browser(), traces: TraceEvent[] = []) {
    const runtime = await createAgentRuntime({
      workingDir, approvalLevel: 5, traceDefault: true,
      handlers: { traceSinks: [event => { traces.push(event); }] },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true, llamaComplete: completion },
    });
    runtimes.push(runtime); return runtime;
  }

  it("allocates distinct owners for two boots and keeps the second usable after the first shuts down", async () => {
    const firstBrowser = browser(), secondBrowser = browser();
    const firstTraces: TraceEvent[] = [], secondTraces: TraceEvent[] = [];
    const first = await boot(firstBrowser, firstTraces), second = await boot(secondBrowser, secondTraces);
    for (const name of ["loop", "toolRegistry", "skillRegistry", "approvals", "slotManager", "sessionStore", "turnController", "steeringInbox", "profileStore", "notesStore", "lessonStore", "procedureStore", "linkStore", "voteStore", "taskStore", "taskRunner", "scheduler", "webhookSessionStore", "mcpManager", "providerRegistry", "telegramChannel", "discordChannel", "swarm", "logger", "metrics"] as const) {
      expect(first[name], name).not.toBeNull(); expect(first[name], name).not.toBe(second[name]);
    }
    // Config cache and process-wide handlers are deliberately outside this identity assertion.
    first.setPlanMode(true); first.setApprovalLevel(1);
    expect(second.getPlanMode()).toBe(false); expect(second.getApprovalLevel()).toBe(5);
    const session = second.createSession({ persist: false });
    expect(second.sessionStore.load(session.id)).toBeNull();
    expect(existsSync(join(directory, "state", "traces", `${session.id}.ndjson`))).toBe(false);
    await first.shutdown();
    expect(firstBrowser.shutdown).toHaveBeenCalledTimes(1); expect(secondBrowser.shutdown).not.toHaveBeenCalled();
    const result = await second.runTurn(session, "hello", { maxSteps: 2 });
    expect(result.reason).toBe("reply");
    expect(second.sessionStore.load(session.id)?.turns.at(-1)).toMatchObject({ kind: "assistant_reply", text: "fixture response" });
    expect(firstTraces).toEqual([]);
    expect(secondTraces.filter(event => event.type === "session_started" && event.sessionId === session.id)).toHaveLength(1);
    expect(existsSync(join(directory, "state", "traces", `${session.id}.ndjson`))).toBe(true);
    await second.shutdown(); expect(secondBrowser.shutdown).toHaveBeenCalledTimes(1);
  });

  it("runs the separated startup recipes in their original dependency order and starts the scheduler after channels", async () => {
    const phases: string[] = [];
    const prepareSkills = skills.prepareRuntimeSkills;
    vi.spyOn(skills, "prepareRuntimeSkills").mockImplementation(async (...args) => {
      phases.push("prepare-skills"); const prepared = await prepareSkills(...args); const createCatalog = prepared.createCatalog;
      vi.spyOn(prepared, "createCatalog").mockImplementation(() => { phases.push("skill-catalog"); return createCatalog(); }); return prepared;
    });
    const sessionStore = sessions.prepareRuntimeSessionStore;
    vi.spyOn(sessions, "prepareRuntimeSessionStore").mockImplementation((...args) => { phases.push("sessions"); return sessionStore(...args); });
    const registry = tools.createRuntimeToolRegistry;
    vi.spyOn(tools, "createRuntimeToolRegistry").mockImplementation((...args) => { phases.push("registry"); return registry(...args); });
    const core = tools.registerRuntimeCoreTools;
    vi.spyOn(tools, "registerRuntimeCoreTools").mockImplementation((...args) => { phases.push("core"); return core(...args); });
    const connectLocal = local.connectRuntimeLocalProfile;
    vi.spyOn(local, "connectRuntimeLocalProfile").mockImplementation(async (...args) => { phases.push("local"); return connectLocal(...args); });
    const providers = inference.connectRuntimeProviders;
    vi.spyOn(inference, "connectRuntimeProviders").mockImplementation(async (...args) => { phases.push("providers"); return providers(...args); });
    const vision = tools.registerRuntimeVisionTools;
    vi.spyOn(tools, "registerRuntimeVisionTools").mockImplementation((...args) => { phases.push("vision"); return vision(...args); });
    const mcp = tools.connectRuntimeMcpCatalog;
    vi.spyOn(tools, "connectRuntimeMcpCatalog").mockImplementation(async (...args) => { phases.push("mcp:start"); const result = await mcp(...args); phases.push("mcp:done"); return result; });
    const stores = tasks.createRuntimeTaskStores;
    vi.spyOn(tasks, "createRuntimeTaskStores").mockImplementation((...args) => { phases.push("task-stores"); return stores(...args); });
    const runner = tasks.createRuntimeTaskRunner;
    vi.spyOn(tasks, "createRuntimeTaskRunner").mockImplementation((...args) => { phases.push("task-tools"); return runner(...args); });
    const fusion = tools.registerRuntimeFusionAndReadScope;
    vi.spyOn(tools, "registerRuntimeFusionAndReadScope").mockImplementation((...args) => { phases.push("fusion/read-scope"); return fusion(...args); });
    const scheduler = tasks.createRuntimeScheduler;
    vi.spyOn(tasks, "createRuntimeScheduler").mockImplementation((...args) => { phases.push("scheduler-construction"); return scheduler(...args); });
    const consolidator = memory.createRuntimeMemoryConsolidator;
    vi.spyOn(memory, "createRuntimeMemoryConsolidator").mockImplementation((...args) => { phases.push("consolidator"); return consolidator(...args); });
    const connectChannels = channels.connectRuntimeChannels;
    vi.spyOn(channels, "connectRuntimeChannels").mockImplementation((...args) => { phases.push("channels:start"); connectChannels(...args); phases.push("channels:connected"); });
    const start = Scheduler.prototype.start;
    vi.spyOn(Scheduler.prototype, "start").mockImplementation(function(this: Scheduler) { phases.push("scheduler:start"); start.call(this); });
    const runtime = await boot();
    expect(phases).toEqual(["prepare-skills", "sessions", "registry", "core", "skill-catalog", "local", "providers", "vision", "mcp:start", "mcp:done", "task-stores", "task-tools", "fusion/read-scope", "scheduler-construction", "consolidator", "channels:start", "channels:connected", "scheduler:start"]);
    expect(runtime.telegramChannel).not.toBeNull(); expect(runtime.discordChannel).not.toBeNull(); expect(runtime.swarm).not.toBeNull();
  });

  it("preserves an early seeding failure and does not proceed to stores or tool registration", async () => {
    const failure = new Error("assembly seeding rejected"); const backend = browser();
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockRejectedValue(failure);
    const stores = vi.spyOn(sessions, "prepareRuntimeSessionStore"), registration = vi.spyOn(tools, "registerRuntimeCoreTools");
    try {
      await expect(createAgentRuntime({ workingDir, approvalLevel: 5, overrides: { browserBackend: backend, skipLlamaHealthCheck: true, llamaComplete: completion } })).rejects.toBe(failure);
      expect(stores).not.toHaveBeenCalled(); expect(registration).not.toHaveBeenCalled();
      expect(backend.shutdown).not.toHaveBeenCalled();
    } finally { await backend.shutdown(); }
  });
});
