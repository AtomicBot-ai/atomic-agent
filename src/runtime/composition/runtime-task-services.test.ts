import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { TaskStore } from "../../tasks/task-store.js";
import type { TaskRunnerRuntime } from "../../tasks/task-runner.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { createRuntimeScheduler, createRuntimeTaskRunner, createRuntimeTaskStores } from "./runtime-task-services.js";

let dir: string;
let config: AtomicAgentConfig;
let prior: string | undefined;
let stores: ReturnType<typeof createRuntimeTaskStores> | undefined;
let scheduler: ReturnType<typeof createRuntimeScheduler>;
const records: LogRecord[] = [];
const logger = new StructuredLogger({ level: "debug", sinks: [(record) => records.push(record)] });
const metrics = new AgentMetrics(new MetricsCollector({ sinks: [] }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-task-composition-"));
  prior = process.env.ATOMIC_AGENT_STATE_DIR; process.env.ATOMIC_AGENT_STATE_DIR = dir;
  resetConfigCache(); config = loadConfig(); config.paths.tasksDbFile = join(dir, "tasks.sqlite");
  config.tasks.enabled = true; config.tasks.agentToolsEnabled = true;
  config.tasks.runOnCreate = false; config.tasks.schedulerEnabled = true;
  stores = undefined; scheduler = null; records.length = 0;
});
afterEach(async () => {
  await scheduler?.stop(); stores?.taskStore.close(); vi.restoreAllMocks(); vi.useRealTimers();
  if (prior === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR; else process.env.ATOMIC_AGENT_STATE_DIR = prior;
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});
function runnerFixture(runTurn: TaskRunnerRuntime["runTurn"] = async (session) => ({ session, reason: "reply", stepCount: 1 })) {
  stores ??= createRuntimeTaskStores({ config, logger });
  const sessions = new Map<string, SessionState>();
  const saved: SessionState[] = [];
  const createSession = (input?: { metadata?: Record<string, unknown>; persist?: boolean }) => {
    const state = createEmptySessionState({ id: `task-session-${sessions.size}`, workingDir: dir, metadata: input?.metadata });
    sessions.set(state.id, state); return state;
  };
  const toolRegistry = new ToolRegistry();
  const resolveTelegram = vi.fn(() => null);
  const runner = createRuntimeTaskRunner({ config, ...stores, runTurn, sessionStore: { load: (id) => sessions.get(id) ?? null, save: (state) => { sessions.set(state.id, state); saved.push(state); } }, createSession, toolRegistry, resolveTelegram, logger, metrics });
  return { runner, sessions, saved, toolRegistry, resolveTelegram };
}

describe("runtime task service phases", () => {
  it("constructs durable stores even with tasks disabled and recovers old claims before a runner exists", () => {
    const old = new TaskStore({ dbFile: config.paths.tasksDbFile });
    const task = old.create({ userMessage: "orphan", origin: "cli", maxAttempts: 2 });
    old.markRunning(task.id, Date.now() - config.tasks.staleAfterMs - 1); old.close();
    config.tasks.enabled = false;
    stores = createRuntimeTaskStores({ config, logger });
    expect(stores.taskStore.get(task.id)?.status).toBe("pending");
    expect(records).toMatchObject([{ message: "recovered stale running tasks on bootstrap", context: { count: 1, thresholdMs: config.tasks.staleAfterMs } }]);
    stores.webhookSessionStore.set("wake", "session-live");
    expect(JSON.parse(readFileSync(join(dir, "webhook-sessions.json"), "utf8"))).toEqual({ wake: "session-live" });
  });

  it("does not log recovery when nothing was stale", () => {
    stores = createRuntimeTaskStores({ config, logger });
    expect(records).toEqual([]);
  });

  it("connects the finished runTurn, creates/saves task sessions and forwards defaults, cancellation and reporting hooks", async () => {
    const calls: Parameters<TaskRunnerRuntime["runTurn"]>[] = [];
    config.agent.maxSteps = 17;
    const fixture = runnerFixture(async (...args) => { calls.push(args); return { session: args[0], reason: "reply", stepCount: 1 }; });
    expect(calls).toEqual([]); expect(fixture.resolveTelegram).not.toHaveBeenCalled();
    const task = fixture.runner.create({ userMessage: "background work", origin: "cli", maxAttempts: 1, notify: "telegram" });
    const controller = new AbortController();
    expect((await fixture.runner.runOne(task.id, controller.signal))?.status).toBe("completed");
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("background work");
    expect(calls[0]?.[2]).toMatchObject({ maxSteps: 17, origin: "scheduler", signal: controller.signal, eventHook: expect.any(Function) });
    expect(fixture.saved.length).toBeGreaterThan(0);
    expect(fixture.resolveTelegram).toHaveBeenCalledTimes(1);
    expect(records.some((record) => record.message === "telegram task report skipped: channel not constructed")).toBe(true);
    expect(fixture.toolRegistry.list().map((tool) => tool.name)).toEqual(["tasks.schedule", "tasks.cron", "tasks.list", "tasks.cancel", "tasks.show"]);
  });

  it.each([{ enabled: false, agentToolsEnabled: true }, { enabled: true, agentToolsEnabled: false }])("gates registration with both task switches: %j", (flags) => {
    Object.assign(config.tasks, flags);
    expect(runnerFixture().toolRegistry.list()).toEqual([]);
  });

  it.each([{ enabled: false, schedulerEnabled: true }, { enabled: true, schedulerEnabled: false }])("does not allocate a scheduler timer when its gate is off: %j", (flags) => {
    Object.assign(config.tasks, flags);
    const { runner } = runnerFixture(); vi.useFakeTimers();
    scheduler = createRuntimeScheduler({ config, taskRunner: runner, logger, metrics });
    expect(scheduler).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it("constructs the scheduler without starting it; the caller chooses first tick after channel connection", async () => {
    const { runner } = runnerFixture(); vi.useFakeTimers();
    config.tasks.schedulerTickMs = 100; config.tasks.schedulerBatch = 3;
    const due = vi.spyOn(runner, "runDue").mockResolvedValue({ drained: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, retried: 0 });
    scheduler = createRuntimeScheduler({ config, taskRunner: runner, logger, metrics });
    expect(scheduler).not.toBeNull(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200); expect(due).not.toHaveBeenCalled();
    scheduler?.start(); await vi.advanceTimersByTimeAsync(100);
    expect(due).toHaveBeenCalledWith(expect.any(Number), 3);
    await scheduler?.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
