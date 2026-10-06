import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import * as analytics from "../../analytics/index.js";
import { AnalyticsStateStore, TurnUsageMeter } from "../../analytics/index.js";
import { createEmptySessionState, createFusionWorkerSession, SESSION_TITLE_TIMEOUT_MS, type SessionState } from "../../session/index.js";
import type { RunTurnOptions, RunTurnResult } from "../../agent/agent-loop.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { TurnController } from "../turn-controller.js";
import { SteeringInbox } from "../steering-inbox.js";
import { createRuntimeTraces } from "./runtime-traces.js";
import { connectRuntimeProviders } from "./runtime-inference.js";
import { createRuntimeTurnService, prepareRuntimeTurnState, type RuntimeTurnDependencies } from "./runtime-turn-service.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("promise not initialized"); };
  let reject: (error: unknown) => void = () => { throw new Error("promise not initialized"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result(state: SessionState, options: RunTurnOptions): RunTurnResult {
  return {
    session: { ...state, turns: [...state.turns, { kind: "user", text: options.userMessage ?? "request", at: 1 }, { kind: "assistant_reply", text: "answer", at: 2 }] },
    reason: "reply", stepCount: 1,
  };
}

function completion(content = "A title"): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 }, cacheHitTokens: 0, slotId: -1, modelId: null };
}

async function flushNaming() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("runtime turn ownership recipes", () => {
  let dir: string;
  let fixture: Awaited<ReturnType<typeof makeFixture>>;
  async function makeFixture() {
    const config = configuration.loadConfig();
    config.agent.nameSessions = false;
    config.tracing.trace.enabled = false;
    vi.spyOn(configuration, "getConfig").mockImplementation(() => config);
    const logger = new StructuredLogger({ level: "debug", sinks: [] });
    const traces = createRuntimeTraces(config, {}, logger);
    const providers = await connectRuntimeProviders(config, logger, { llama: new LlamaServerClient(), modelAlias: null }, { getLiveProfile: () => PLAIN_INSTRUCT_PROFILE, getLiveModelId: () => null });
    const state = prepareRuntimeTurnState();
    const events: string[] = [];
    const rows = new Map<string, SessionState>();
    const turnRequests = new Map<string, string>();
    const sessionStore: RuntimeTurnDependencies["sessions"]["sessionStore"] = {
      save: value => { events.push("save"); rows.set(value.id, value); },
      load: id => rows.get(id) ?? null,
      beginTurn: () => { events.push("begin"); return true; },
      releaseTurn: (id, ending) => {
        events.push(`release:${ending.status}`);
        const existing = rows.get(id);
        if (existing) rows.set(id, { ...existing, ...ending });
        return true;
      },
      finishTurn: value => { events.push("finish"); rows.set(value.id, value); },
    };
    const loop = { runTurn: vi.fn(async (value: SessionState, options: RunTurnOptions) => {
      events.push("loop"); expect(traces.turnContext.getStore()?.sessionId).toBe(value.id);
      return result(value, options);
    }) };
    const turnController = new TurnController();
    const steeringInbox = new SteeringInbox();
    let closing = false;
    const deps: RuntimeTurnDependencies = {
      sessions: { sessionStore, turnContext: traces.turnContext, turnRequests },
      execution: {
        loop, turnController, steeringInbox,
        shellJobs: { endSession: id => { events.push(`shell-session:${id}`); return []; }, endTurn: () => { events.push("shell-turn"); return []; } },
        slotManager: { sideCallSlotId: () => 7 }, llmComplete: async () => completion(),
      },
      inference: { ...providers, fallbackChain: { standingOverrideFor: () => null } },
      traces: {
        ensureRecorder: () => { events.push("recorder"); return null; },
        pinSession: () => { events.push("pin"); },
        readContextUsage: () => undefined,
        clearContextUsage: id => { events.push(`clear:${id}`); traces.clearContextUsage(id); },
        releaseSession: id => { events.push(`unpin:${id}`); traces.releaseSession(id); },
      },
      telemetry: { observability: { getAnalytics: () => null }, analyticsStateStore: new AnalyticsStateStore(join(dir, "analytics.json")), turnUsageMeter: new TurnUsageMeter() },
      state, lifecycle: { isShutdown: () => closing }, logger,
    };
    const service = createRuntimeTurnService(config, deps);
    return { config, traces, providers, state, events, rows, turnRequests, sessionStore, loop, turnController, steeringInbox, deps, service, setClosing: (value: boolean) => { closing = value; } };
  }
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atomic-runtime-turns-")); fixture = await makeFixture(); });
  afterEach(async () => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    for (const id of fixture.providers.providerRegistry.listIds()) await fixture.providers.providerRegistry.getProvider(id)?.close();
    await rm(dir, { recursive: true, force: true });
  });
  function session(id = "session") { return createEmptySessionState({ id, workingDir: dir }); }

  it("state preparation creates fresh shutdown-shared handles without starting work", () => {
    const next = prepareRuntimeTurnState();
    expect(next.pendingSessionNamings).not.toBe(fixture.state.pendingSessionNamings);
    expect(next.turnsInFlight).not.toBe(fixture.state.turnsInFlight);
    expect(next.pendingSessionNamings.size).toBe(0);
  });

  it("executeTurn is an already-locked seam and preserves final cleanup order", async () => {
    const enqueue = vi.spyOn(fixture.turnController, "enqueue");
    const output = await fixture.service.executeTurn(session(), "request");
    expect(enqueue).not.toHaveBeenCalled();
    expect(output.session.metadata?.llm).toBeDefined();
    expect(fixture.events).toEqual(["recorder", "pin", "begin", "loop", "finish", "shell-turn", "clear:session", "unpin:session"]);
    expect(fixture.turnRequests.size).toBe(0);
    expect(fixture.rows.get("session")).toBe(output.session);
  });

  it("loop budgets retain ceiling/leg distinction, option order and the supplied signal", async () => {
    fixture.config.agent.maxSteps = 10;
    const abort = new AbortController();
    const filter = () => true;
    await fixture.service.executeTurn(session(), "request", { maxSteps: 17, taskMaxDurationMs: 200, reasoningEffort: "high", maxOutputTokens: 99, toolFilter: filter, signal: abort.signal });
    const options = fixture.loop.runTurn.mock.calls[0]?.[1];
    expect(options).toMatchObject({ maxSteps: 10, taskMaxSteps: 17, taskMaxDurationMs: 200, reasoningEffort: "high", maxOutputTokens: 99, toolFilter: filter, signal: abort.signal });
    expect(Object.keys(options ?? {})).toEqual(["userMessage", "originalRequest", "reasoningEffort", "maxOutputTokens", "maxSteps", "taskMaxSteps", "taskMaxDurationMs", "toolFilter", "signal"]);
    await fixture.service.executeTurn(session("other"), "request");
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).not.toHaveProperty("taskMaxSteps");
  });

  it("unknown pins reject before enqueue and before recorder/all other turn work", async () => {
    const enqueue = vi.spyOn(fixture.turnController, "enqueue");
    await expect(fixture.service.runTurn(session(), "request", { providerId: "unknown" }))
      .rejects.toThrow('cannot pin turn to llm provider "unknown": not configured');
    expect(enqueue).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it("same-session queued callbacks load state when they acquire the lock", async () => {
    const gate = deferred<void>();
    fixture.loop.runTurn.mockImplementationOnce(async (value, options) => { await gate.promise; return result(value, options); });
    const stale = session();
    const first = fixture.service.runTurn(stale, "first", { origin: "scheduler" });
    const second = fixture.service.runTurn(stale, "second", { origin: "scheduler" });
    gate.resolve();
    await Promise.all([first, second]);
    expect(fixture.loop.runTurn.mock.calls[1]?.[0].turns).toHaveLength(2);
    expect(fixture.rows.get(stale.id)?.turns).toHaveLength(4);
  });

  it("queued cancellation never invokes the loop and different sessions remain independent", async () => {
    const gate = deferred<void>();
    fixture.loop.runTurn.mockImplementationOnce(async (value, options) => { await gate.promise; return result(value, options); });
    const first = fixture.service.runTurn(session(), "first", { origin: "scheduler" });
    await flushNaming();
    const abort = new AbortController();
    const failure = new Error("cancel queued");
    const queued = fixture.service.runTurn(session(), "queued", { origin: "scheduler", signal: abort.signal });
    abort.abort(failure);
    await expect(queued).rejects.toBe(failure);
    const independent = await fixture.service.runTurn(session("independent"), "other", { origin: "scheduler" });
    expect(independent.session.id).toBe("independent");
    gate.resolve(); await first;
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(2);
  });

  it("cancelled thrown turns restore the old error and release before cleanup", async () => {
    const old = { ...session(), lastError: "prior error" };
    fixture.rows.set(old.id, old);
    const abort = new AbortController(); abort.abort();
    const failure = new Error("transport wrapped abort");
    fixture.loop.runTurn.mockRejectedValue(failure);
    await expect(fixture.service.executeTurn(old, "request", { signal: abort.signal })).rejects.toBe(failure);
    expect(fixture.rows.get(old.id)).toMatchObject({ status: "cancelled", lastError: "prior error" });
    expect(fixture.events.slice(-4)).toEqual(["release:cancelled", "shell-turn", "clear:session", "unpin:session"]);
  });

  it("ephemeral workers bypass persistence, trace pins and normal turn tracking", async () => {
    const worker = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task" } });
    const begin = vi.spyOn(fixture.state.turnsInFlight, "begin");
    await fixture.service.executeTurn(worker, "brief");
    expect(fixture.loop.runTurn.mock.calls[0]?.[1]).toMatchObject({ ephemeral: true, userMessage: "brief" });
    expect(begin).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["loop", `clear:${worker.id}`, `shell-session:${worker.id}`]);
    expect(fixture.rows.size).toBe(0);
    expect(fixture.turnRequests.size).toBe(0);
  });

  it("steering checks only the actual inbox acceptance gate", () => {
    const busy = vi.spyOn(fixture.turnController, "isBusy").mockImplementation(() => { throw new Error("must not check busy"); });
    expect(fixture.service.steer("session", "change")).toBe(false);
    fixture.steeringInbox.open("session");
    expect(fixture.service.steer("session", "change")).toBe(true);
    expect(fixture.steeringInbox.drain("session")).toEqual(["change"]);
    expect(busy).not.toHaveBeenCalled();
  });

  it("telemetry reads analytics at settlement and excludes scheduler/fusion turns", async () => {
    const getAnalytics = vi.spyOn(fixture.deps.telemetry.observability, "getAnalytics");
    const capture = vi.spyOn(analytics, "captureMessageSent");
    await fixture.service.runTurn(session(), "request", { origin: "scheduler" });
    await fixture.service.runTurn(session("fusion"), "request", { origin: "fusion" });
    expect(getAnalytics).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    await fixture.service.runTurn(session("human"), "request");
    expect(getAnalytics).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(null, fixture.deps.telemetry.analyticsStateStore, expect.objectContaining({ outcome: "reply", stepCount: 1 }));
  });

  it("late naming rereads stored state and respects an operator's first title", async () => {
    vi.useFakeTimers(); fixture.config.agent.nameSessions = true;
    const gate = deferred<CompletionResult>();
    fixture.deps.execution.llmComplete = async () => gate.promise;
    // Reconstruct the recipe with the same borrowed handles and the changed completion dependency.
    const service = createRuntimeTurnService(fixture.config, fixture.deps);
    const output = await service.executeTurn(session(), "request");
    expect(fixture.state.pendingSessionNamings.size).toBe(1);
    fixture.rows.set(output.session.id, { ...output.session, metadata: { ...output.session.metadata, title: "Operator title", custom: 7 } });
    gate.resolve(completion("Generated title")); await flushNaming();
    expect(fixture.rows.get(output.session.id)?.metadata).toMatchObject({ title: "Operator title", custom: 7 });
    expect(fixture.state.pendingSessionNamings.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("shutdown forbids late naming saves and new naming controllers", async () => {
    vi.useFakeTimers(); fixture.config.agent.nameSessions = true;
    const gate = deferred<CompletionResult>();
    fixture.deps.execution.llmComplete = async () => gate.promise;
    const service = createRuntimeTurnService(fixture.config, fixture.deps);
    const output = await service.executeTurn(session(), "request");
    fixture.setClosing(true);
    gate.resolve(completion()); await flushNaming();
    expect(fixture.rows.get(output.session.id)?.metadata?.title).toBeUndefined();
    expect(fixture.state.pendingSessionNamings.size).toBe(0);
    await service.executeTurn(session("after-close"), "request");
    expect(fixture.state.pendingSessionNamings.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("naming's original deadline aborts its forwarded signal and releases its pending handle", async () => {
    vi.useFakeTimers(); fixture.config.agent.nameSessions = true;
    let signal: AbortSignal | undefined;
    fixture.deps.execution.llmComplete = params => new Promise((resolve, reject) => {
      void resolve; signal = params.signal;
      if (!signal) throw new Error("naming signal missing");
      signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
    });
    const service = createRuntimeTurnService(fixture.config, fixture.deps);
    await service.executeTurn(session(), "request");
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SESSION_TITLE_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
    expect(fixture.state.pendingSessionNamings.size).toBe(0);
  });
});
