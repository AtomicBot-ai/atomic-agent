import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import * as analytics from "../../analytics/index.js";
import { AnalyticsStateStore, TurnUsageMeter } from "../../analytics/index.js";
import { createEmptySessionState, createFusionWorkerSession, SESSION_TITLE_TIMEOUT_MS, type SessionState } from "../../session/index.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { NO_OPERATOR_WORDS_MARKER } from "../../prompt/request-section.js";
import type { RunTurnOptions, RunTurnResult } from "../../agent/agent-loop.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { TurnController } from "../turn-controller.js";
import { SteeringInbox } from "../steering-inbox.js";
import { createRuntimeTraces } from "./runtime-traces.js";
import { connectRuntimeProviders } from "./runtime-inference.js";
import { createRuntimeTurnService, prepareRuntimeTurnState, stoppedForMoney, type RuntimeTurnDependencies } from "./runtime-turn-service.js";
import { SessionHookEngine } from "../../hooks/session-hook-engine.js";
import { parseHooksObject } from "../../hooks/hook-config.js";
import { resolveModelMode } from "../../llm/model-mode.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { TurnProgress } from "../../session/turn-progress.js";
import { INTERRUPTED_TURN_ENDING } from "../../session/session-store.js";
import { currentBrowserScope, onBrowserWorkerEnd, runInBrowserScope, type BrowserRunScope } from "../../tools/browser/browser-run-scope.js";
import { resolveStepGrammar } from "../../agent/step/step-inference.js";

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
    const turnPreviousReplies = new Map<string, string>();
    const checkpoints: Array<{ state: SessionState; progress: TurnProgress }> = [];
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
      checkpointTurn: (value, progress) => { events.push(`checkpoint:${progress.stepsDone}`); checkpoints.push({ state: value, progress }); return true; },
    };
    const loop = { runTurn: vi.fn(async (value: SessionState, options: RunTurnOptions) => {
      events.push("loop"); expect(traces.turnContext.getStore()?.sessionId).toBe(value.id);
      return result(value, options);
    }) };
    const turnController = new TurnController();
    const steeringInbox = new SteeringInbox();
    let closing = false;
    let stopping = false;
    const deps: RuntimeTurnDependencies = {
      sessions: { sessionStore, turnContext: traces.turnContext, turnRequests, turnPreviousReplies },
      execution: {
        loop, turnController, steeringInbox,
        shellJobs: { endSession: id => { events.push(`shell-session:${id}`); return []; }, endTurn: () => { events.push("shell-turn"); return []; } },
        slotManager: { sideCallSlotId: () => 7, release: id => { events.push(`slot-release:${id}`); } }, llmComplete: async () => completion(),
      },
      inference: { ...providers, fallbackChain: { standingOverrideFor: () => null, setTurnPrimary: () => {} } },
      traces: {
        ensureRecorder: () => { events.push("recorder"); return null; },
        pinSession: () => { events.push("pin"); },
        readContextUsage: () => undefined,
        clearContextUsage: id => { events.push(`clear:${id}`); traces.clearContextUsage(id); },
        releaseSession: id => { events.push(`unpin:${id}`); traces.releaseSession(id); },
      },
      telemetry: { observability: { getAnalytics: () => null }, analyticsStateStore: new AnalyticsStateStore(join(dir, "analytics.json")), turnUsageMeter: new TurnUsageMeter() },
      state, lifecycle: { isShutdown: () => closing, isStopping: () => stopping }, logger,
    };
    const service = createRuntimeTurnService(config, deps);
    return { config, traces, providers, state, events, rows, checkpoints, turnRequests, turnPreviousReplies, sessionStore, loop, turnController, steeringInbox, deps, service, setClosing: (value: boolean) => { closing = value; }, setStopping: (value: boolean) => { stopping = value; } };
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
    expect(Object.keys(options ?? {})).toEqual(["userMessage", "modelModePolicy", "originalRequest", "reasoningEffort", "maxOutputTokens", "maxSteps", "taskMaxSteps", "taskMaxDurationMs", "toolFilter", "signal", "onStepCheckpoint"]);
    await fixture.service.executeTurn(session("other"), "request");
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).not.toHaveProperty("taskMaxSteps");
  });

  it("a memoryReadOnly turn (skill eval) reaches the loop with the memory write tools hidden", async () => {
    await fixture.service.executeTurn(session(), "request", { memoryReadOnly: true, toolFilter: (name) => name !== "os.fs.read" });
    const options = fixture.loop.runTurn.mock.calls[0]?.[1];
    expect(options?.memoryReadOnly).toBe(true);
    const filter = options?.toolFilter;
    expect(filter?.("memory.notes.store")).toBe(false);
    expect(filter?.("memory.profile.set")).toBe(false);
    expect(filter?.("memory.notes.recall")).toBe(true);
    expect(filter?.("os.fs.read")).toBe(false);
    await fixture.service.executeTurn(session("other"), "request");
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).not.toHaveProperty("memoryReadOnly");
  });

  it("hides ask_user from desktop turns and keeps it for the TUI, the CLI and Telegram (ATO-489)", async () => {
    const optionsFor = async (id: string, extra: Parameters<typeof fixture.service.executeTurn>[2]) => {
      await fixture.service.executeTurn(session(id), "request", extra);
      return fixture.loop.runTurn.mock.calls.at(-1)?.[1];
    };
    // The desktop: the sidecar, and an HTTP extensions client without the flag.
    for (const [id, extra] of [
      ["sidecar", { origin: "sidecar" as const }],
      ["desktop-http", { origin: "http" as const, answerChannel: "desktop" as const }],
      ["plain-http", { origin: "http" as const }],
    ] as const) {
      const filter = (await optionsFor(id, extra))?.toolFilter;
      expect(filter, id).toBeDefined();
      expect(filter!("ask_user"), id).toBe(false);
      expect(filter!("fs.read"), id).toBe(true);
    }
    // Surfaces that draw the question card keep it (their filter only
    // hides the board card tools a chat turn never gets, ATO-2497).
    for (const [id, extra] of [
      ["tui", { origin: "tui" as const }],
      ["telegram", { origin: "telegram" as const }],
      ["cli", {}],
      ["declared", { origin: "http" as const, answerChannel: "desktop" as const, questions: true }],
    ] as const) {
      const filter = (await optionsFor(id, extra))?.toolFilter;
      expect(filter, id).toBeDefined();
      expect(filter!("ask_user"), id).toBe(true);
      expect(filter!("fs.read"), id).toBe(true);
    }
    // A caller's own filter still applies on a desktop turn.
    const own = await optionsFor("own", { origin: "sidecar", toolFilter: (name) => name !== "fs.write" });
    expect(own?.toolFilter?.("fs.write")).toBe(false);
    expect(own?.toolFilter?.("ask_user")).toBe(false);
    expect(own?.toolFilter?.("fs.read")).toBe(true);
  });

  it("offers the board card tools only on a task's run (ATO-2497)", async () => {
    const optionsFor = async (id: string, extra: Parameters<typeof fixture.service.executeTurn>[2]) => {
      await fixture.service.executeTurn(session(id), "request", extra);
      return fixture.loop.runTurn.mock.calls.at(-1)?.[1];
    };
    const board = ["tasks.request_review", "tasks.block", "tasks.comment"];
    for (const [id, extra] of [
      ["tui", { origin: "tui" as const }],
      ["sidecar", { origin: "sidecar" as const }],
      // The scheduler's origin alone is not a task run: the task id is.
      ["scheduler-no-task", { origin: "scheduler" as const }],
    ] as const) {
      const filter = (await optionsFor(id, extra))?.toolFilter;
      for (const name of board) expect(filter!(name), `${id} ${name}`).toBe(false);
      expect(filter!("tasks.list"), id).toBe(true);
    }
    const task = await optionsFor("task-run", {
      origin: "scheduler",
      checkpoint: { taskId: "t-1", resumes: 0, request: "request" },
    });
    for (const name of board) expect(task?.toolFilter?.(name) ?? true, name).toBe(true);
    // A caller's own filter still applies on a task's run.
    const own = await optionsFor("task-own", {
      origin: "scheduler",
      checkpoint: { taskId: "t-2" },
      toolFilter: (name) => name !== "tasks.comment",
    });
    expect(own?.toolFilter?.("tasks.comment")).toBe(false);
    expect(own?.toolFilter?.("tasks.block")).toBe(true);
  });

  it("keeps a chat turn's grammar byte-identical while hiding the board card tools (ATO-2497)", async () => {
    const optionsFor = async (id: string, extra: Parameters<typeof fixture.service.executeTurn>[2]) => {
      await fixture.service.executeTurn(session(id), "request", extra);
      return fixture.loop.runTurn.mock.calls.at(-1)?.[1];
    };
    const grammar = "tool-name ::= old\n";
    const descriptors = ["reply", "finish", "tasks.list", "tasks.comment", "tasks.block", "tasks.request_review"]
      .map((name) => ({ name, summary: name, argsSchema: "{}" }));
    const grammarFor = (toolFilter: ((name: string) => boolean) | undefined) => resolveStepGrammar(
      toolFilter !== undefined ? { toolFilter } : {},
      { grammar, registry: {} as never },
      descriptors,
      false,
      false,
    );
    // A TUI turn had no filter: the base grammar goes out untouched.
    const tui = (await optionsFor("tui-grammar", { origin: "tui" }))?.toolFilter;
    expect(tui?.("tasks.comment")).toBe(false);
    expect(grammarFor(tui)).toBe(grammar);
    // A desktop turn already narrowed for ask_user still narrows.
    const desktop = (await optionsFor("desktop-grammar", { origin: "sidecar" }))?.toolFilter;
    expect(grammarFor(desktop)).not.toBe(grammar);
  });

  it("records a desktop turn as unable to ask for the length of the turn only (ATO-489)", async () => {
    const turnsWithoutQuestions = new Set<string>();
    const service = createRuntimeTurnService(fixture.config, {
      ...fixture.deps,
      sessions: { ...fixture.deps.sessions, turnsWithoutQuestions },
    });
    const seen: boolean[] = [];
    fixture.loop.runTurn.mockImplementation(async (value: SessionState, options: RunTurnOptions) => {
      seen.push(turnsWithoutQuestions.has(value.id));
      return result(value, options);
    });
    await service.executeTurn(session("desk"), "request", { origin: "sidecar" });
    await service.executeTurn(session("term"), "request", { origin: "tui" });
    expect(seen).toEqual([true, false]);
    expect(turnsWithoutQuestions.size).toBe(0);
  });

  it("marks the turn's progress at its start and checkpoints every completed step (ATO-1109)", async () => {
    const begin = vi.spyOn(fixture.sessionStore, "beginTurn");
    fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) => {
      fixture.events.push("loop");
      const afterStep = { ...value, turns: [...value.turns, userTurn("task words")] };
      options.onStepCheckpoint?.(afterStep, { stepIndex: 0, stepsTaken: 1 });
      options.onStepCheckpoint?.(afterStep, { stepIndex: 1, stepsTaken: 2 });
      return result(value, options);
    });
    await fixture.service.executeTurn(session(), "[Resumed] note\n\nThe task:\ntask words", {
      maxSteps: 40, checkpoint: { taskId: "task-1", resumes: 2, request: "task words" },
    });
    const initial = begin.mock.calls[0]?.[2];
    expect(initial).toMatchObject({ stepsDone: 0, lastStepIndex: -1, request: "task words", resumes: 2, options: { taskId: "task-1", maxSteps: 40 } });
    expect(fixture.checkpoints.map((c) => [c.progress.stepsDone, c.progress.lastStepIndex])).toEqual([[1, 0], [2, 1]]);
    expect(fixture.checkpoints[1]?.progress).toMatchObject({ request: "task words", resumes: 2, options: { taskId: "task-1" } });
    expect(fixture.checkpoints[0]?.state.turns.at(-1)).toMatchObject({ kind: "user", text: "task words" });
    expect(fixture.events).toEqual(["recorder", "pin", "begin", "loop", "checkpoint:1", "checkpoint:2", "finish", "shell-turn", "clear:session", "unpin:session"]);
  });

  it("a checkpoint that cannot be written does not stop the turn", async () => {
    vi.spyOn(fixture.sessionStore, "checkpointTurn").mockImplementation(() => { throw new Error("database is locked"); });
    fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) => {
      options.onStepCheckpoint?.(value, { stepIndex: 0, stepsTaken: 1 });
      return result(value, options);
    });
    const output = await fixture.service.executeTurn(session(), "request");
    expect(output.reason).toBe("reply");
  });

  it("the model router never moves a pinned turn, and an unrouted turn resets the chain head (ATO-483)", async () => {
    const setTurnPrimary = vi.spyOn(fixture.deps.inference.fallbackChain, "setTurnPrimary");
    const active = resolveLlmConfig(fixture.config).activeTextProvider;
    // No llm.json in this state dir, so `config.llm` is unset: give it the
    // resolved defaults plus the router.
    fixture.config.llm = { ...resolveLlmConfig(fixture.config), router: { enabled: true, rules: [{ provider: active }] } } as never;
    await fixture.service.executeTurn(session(), "request", { providerId: active });
    expect(setTurnPrimary).not.toHaveBeenCalled();
    // A rule naming the active provider routes nothing: the head is put
    // back, and the router never pins the turn itself.
    await fixture.service.executeTurn(session("other"), "request");
    expect(setTurnPrimary).toHaveBeenCalledWith("other", null);
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).not.toHaveProperty("providerId");
  });

  it("unknown pins reject before enqueue and before recorder/all other turn work", async () => {
    const enqueue = vi.spyOn(fixture.turnController, "enqueue");
    await expect(fixture.service.runTurn(session(), "request", { providerId: "unknown" }))
      .rejects.toThrow('cannot pin turn to llm provider "unknown": not configured');
    expect(enqueue).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it("a turn on a project's own cloud model runs pinned to it and leaves the active provider and config alone (ATO-1148)", async () => {
    const local = resolveLlmConfig(fixture.config).providers[0]!;
    fixture.config.llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        local,
        { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.invalid/v1", apiKey: "k", defaultChatModel: "default-model" },
      ],
    } as never;
    const registry = fixture.providers.providerRegistry;
    await registry.mergeProvidersFromConfig(fixture.config, { config: fixture.config, logger: fixture.deps.logger } as never);
    const swap = vi.spyOn(registry, "swapActive");

    const output = await fixture.service.runTurn(session(), "request", { providerId: "cloud", model: "project-model" });

    const options = fixture.loop.runTurn.mock.calls[0]?.[1];
    expect(options).toMatchObject({ providerId: "cloud", model: "project-model" });
    expect(output.session.metadata?.llm).toEqual({ providerId: "cloud", chatModel: "project-model" });
    expect(output.session.metadata?.llmRoute).toMatchObject({ main: { providerId: "cloud", model: "project-model" } });
    expect(swap).not.toHaveBeenCalled();
    expect(registry.activeTextProviderId).toBe("local-llama");
    expect(resolveLlmConfig(fixture.config).activeTextProvider).toBe("local-llama");
    expect(resolveLlmConfig(fixture.config).providers.find((p) => p.id === "cloud")?.defaultChatModel).toBe("default-model");
  });

  it("a per-turn model is refused before enqueue on a local provider or without a provider (ATO-1148)", async () => {
    const enqueue = vi.spyOn(fixture.turnController, "enqueue");
    await expect(fixture.service.runTurn(session(), "request", { providerId: "local-llama", model: "other.gguf" }))
      .rejects.toThrow(/local model, which is shared by all projects/);
    await expect(fixture.service.runTurn(session(), "request", { model: "some-model" }))
      .rejects.toThrow(/needs the provider it runs on/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(fixture.loop.runTurn).not.toHaveBeenCalled();
  });

  it("a Fusion turn may ask a local OpenAI-compatible server for its role's model; other origins may not (ATO-1560)", async () => {
    const local = resolveLlmConfig(fixture.config).providers[0]!;
    fixture.config.llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        local,
        { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", defaultChatModel: "default-model" },
      ],
    } as never;
    const registry = fixture.providers.providerRegistry;
    await registry.mergeProvidersFromConfig(fixture.config, { config: fixture.config, logger: fixture.deps.logger } as never);

    await expect(fixture.service.runTurn(session(), "request", { providerId: "lmstudio", model: "qwen3-coder-30b", origin: "http" }))
      .rejects.toThrow(/local model, which is shared by all projects/);
    expect(fixture.loop.runTurn).not.toHaveBeenCalled();

    await fixture.service.runTurn(session(), "request", { providerId: "lmstudio", model: "qwen3-coder-30b", origin: "fusion" });
    expect(fixture.loop.runTurn.mock.calls[0]?.[1]).toMatchObject({ providerId: "lmstudio", model: "qwen3-coder-30b" });
    // A llama-server link still serves only the model it loaded.
    await expect(fixture.service.runTurn(session(), "request", { providerId: "local-llama", model: "other.gguf", origin: "fusion" }))
      .rejects.toThrow(/local model, which is shared by all projects/);
  });

  it("a per-turn model on a server on this machine is allowed for fusion and subagent turns only (ATO-1669)", async () => {
    const local = resolveLlmConfig(fixture.config).providers[0]!;
    fixture.config.llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        local,
        { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", defaultChatModel: "default-model" },
      ],
    } as never;
    const registry = fixture.providers.providerRegistry;
    await registry.mergeProvidersFromConfig(fixture.config, { config: fixture.config, logger: fixture.deps.logger } as never);

    await expect(fixture.service.runTurn(session("person"), "request", { providerId: "lmstudio", model: "role-model" }))
      .rejects.toThrow(/local model, which is shared by all projects/);
    expect(fixture.loop.runTurn).not.toHaveBeenCalled();

    await fixture.service.runTurn(session("fusion"), "request", { origin: "fusion", providerId: "lmstudio", model: "role-model" });
    await fixture.service.runTurn(session("subagent"), "request", { origin: "subagent", providerId: "lmstudio", model: "role-model" });
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(2);
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).toMatchObject({ providerId: "lmstudio", model: "role-model" });
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

  const cancelledLoop = () => fixture.loop.runTurn.mockImplementation(async (value: SessionState, options: RunTurnOptions) => {
    const out = result(value, options);
    return { ...out, session: { ...out.session, status: "cancelled", lastError: null }, reason: "cancelled" } as RunTurnResult;
  });

  it("a chat turn cancelled while the host stops ends as interrupted, its transcript kept (ATO-1688)", async () => {
    cancelledLoop();
    fixture.setStopping(true);
    const output = await fixture.service.executeTurn(session(), "request");
    expect(fixture.rows.get("session")).toMatchObject({ status: INTERRUPTED_TURN_ENDING.status, lastError: INTERRUPTED_TURN_ENDING.lastError });
    expect(fixture.rows.get("session")?.turns.map((t) => t.kind)).toEqual(["user", "assistant_reply"]);
    expect(output.session.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
  });

  it("a person's Stop keeps its own end, with the host running or only shutting down (ATO-1688)", async () => {
    cancelledLoop();
    await fixture.service.executeTurn(session("a"), "request");
    expect(fixture.rows.get("a")).toMatchObject({ status: "cancelled", lastError: null });
    fixture.setClosing(true);
    await fixture.service.executeTurn(session("b"), "request");
    expect(fixture.rows.get("b")).toMatchObject({ status: "cancelled", lastError: null });
  });

  it("a task's turn cancelled while the host stops keeps its own end: the task runner runs it again (ATO-1688)", async () => {
    cancelledLoop();
    fixture.setStopping(true);
    await fixture.service.executeTurn(session(), "request", { checkpoint: { taskId: "task-1" } });
    expect(fixture.rows.get("session")).toMatchObject({ status: "cancelled", lastError: null });
  });

  it("a thrown chat turn aborted while the host stops is released as interrupted (ATO-1688)", async () => {
    const old = { ...session(), lastError: "prior error" };
    fixture.rows.set(old.id, old);
    const abort = new AbortController(); abort.abort();
    const failure = new Error("transport wrapped abort");
    fixture.loop.runTurn.mockRejectedValue(failure);
    fixture.setStopping(true);
    await expect(fixture.service.executeTurn(old, "request", { signal: abort.signal })).rejects.toBe(failure);
    expect(fixture.rows.get(old.id)).toMatchObject(INTERRUPTED_TURN_ENDING);
  });

  it("ephemeral workers bypass persistence, trace pins and normal turn tracking", async () => {
    const worker = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task" } });
    const begin = vi.spyOn(fixture.state.turnsInFlight, "begin");
    await fixture.service.executeTurn(worker, "brief");
    expect(fixture.loop.runTurn.mock.calls[0]?.[1]).toMatchObject({ ephemeral: true, userMessage: "brief" });
    expect(begin).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["loop", `clear:${worker.id}`, `shell-session:${worker.id}`, `slot-release:${worker.id}`]);
    expect(fixture.rows.size).toBe(0);
    expect(fixture.turnRequests.size).toBe(0);
  });

  it("a worker browses as its parent's worker and its browser tabs end with its turn, even when it throws (ATO-961)", async () => {
    const ended: string[] = [];
    const stop = onBrowserWorkerEnd(id => { ended.push(id); });
    try {
      const scopes: Array<{ scope: BrowserRunScope | undefined; endedSoFar: string[] }> = [];
      fixture.loop.runTurn.mockImplementation(async (value, options) => {
        scopes.push({ scope: currentBrowserScope(), endedSoFar: [...ended] });
        if (options.userMessage === "throws") throw new Error("worker failed");
        return result(value, options);
      });
      const watched = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task" } });
      await runInBrowserScope({ sessionId: "parent", attended: true }, () => fixture.service.executeTurn(watched, "brief"));
      expect(scopes[0]?.scope).toEqual({ sessionId: watched.id, attended: true, workerOf: "parent" });
      // Not before the turn ran: the worker still needed its tabs then.
      expect(scopes[0]?.endedSoFar).toEqual([]);
      expect(ended).toEqual([watched.id]);

      const failing = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task-2" } });
      await expect(fixture.service.executeTurn(failing, "throws")).rejects.toThrow("worker failed");
      expect(scopes[1]?.scope).toEqual({ sessionId: failing.id, attended: false, workerOf: "parent" });
      expect(ended).toEqual([watched.id, failing.id]);
    } finally {
      stop();
    }
  });

  it("records the reply a turn answers for the input guard, hands it to workers, and clears both (ATO-860)", async () => {
    const parent = { ...session("parent"), turns: [userTurn("Clean sales.csv"), assistantReplyTurn("Replace sales.csv?")] };
    const worker = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task" } });
    const seen: Array<{ reply: string | undefined; request: string | undefined }> = [];
    fixture.loop.runTurn.mockImplementationOnce(async (value, options) => {
      seen.push({ reply: fixture.turnPreviousReplies.get(value.id), request: fixture.turnRequests.get(value.id) });
      await fixture.service.executeTurn(worker, "brief without a quoted request");
      return result(value, options);
    }).mockImplementationOnce(async (value, options) => {
      seen.push({ reply: fixture.turnPreviousReplies.get(value.id), request: fixture.turnRequests.get(value.id) });
      return result(value, options);
    });
    await fixture.service.executeTurn(parent, "yes");
    expect(seen[0]?.reply).toBe("Replace sales.csv?");
    // The worker reads its parent's question; its block-less brief agrees to nothing.
    expect(seen[1]?.reply).toBe("Replace sales.csv?");
    expect(seen[1]?.request?.startsWith(NO_OPERATOR_WORDS_MARKER)).toBe(true);
    expect(fixture.turnPreviousReplies.size).toBe(0);
    expect(fixture.turnRequests.size).toBe(0);
  });

  it("holds the parent's modes for workers created after a setting edit, then refreshes the next turn", async () => {
    const providerId = fixture.providers.providerRegistry.activeText.id;
    const llm = resolveLlmConfig(fixture.config);
    fixture.config.llm = { ...llm, providers: llm.providers.map(p => ({ ...p, modelMode: "cloud" as const })) };
    const started = deferred<RunTurnOptions>();
    const resume = deferred<void>();
    fixture.loop.runTurn.mockImplementationOnce(async (value, options) => {
      started.resolve(options);
      await resume.promise;
      return result(value, options);
    });
    const parent = fixture.service.executeTurn(session("parent"), "request");
    const options = await started.promise;
    expect(resolveModelMode(options.modelModePolicy!, providerId).mode).toBe("cloud");
    fixture.config.llm = { ...fixture.config.llm, providers: fixture.config.llm.providers.map(p => ({ ...p, modelMode: "local" as const })) };
    const worker = createFusionWorkerSession({ workingDir: dir, meta: { parentSessionId: "parent", taskId: "task" } });
    await fixture.service.executeTurn(worker, "brief", { providerId });
    const workerOptions = fixture.loop.runTurn.mock.calls[1]![1];
    expect(workerOptions.modelModePolicy).toBe(options.modelModePolicy);
    expect(resolveModelMode(workerOptions.modelModePolicy!, providerId).mode).toBe("cloud");
    resume.resolve();
    await parent;
    await fixture.service.executeTurn(session("parent"), "next");
    expect(resolveModelMode(fixture.loop.runTurn.mock.calls[2]![1].modelModePolicy!, providerId).mode).toBe("local");
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

  it("telemetry excludes subagent worker turns like fusion ones (ATO-1669)", async () => {
    const getAnalytics = vi.spyOn(fixture.deps.telemetry.observability, "getAnalytics");
    const capture = vi.spyOn(analytics, "captureMessageSent");
    const begin = vi.spyOn(fixture.deps.telemetry.turnUsageMeter, "begin");
    await fixture.service.runTurn(session("subagent"), "request", { origin: "subagent" });
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(1);
    expect(getAnalytics).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    await fixture.service.runTurn(session("human"), "request");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("hands a person's turn its metered token totals, and leaves them off when nothing was reported (ATO-276)", async () => {
    const meter = fixture.deps.telemetry.turnUsageMeter;
    fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) => {
      meter.record({ sessionId: value.id, usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 } });
      meter.record({ sessionId: value.id, usage: { promptTokens: 30, completionTokens: 2, totalTokens: 32 } });
      return result(value, options);
    });
    const metered = await fixture.service.runTurn(session("metered"), "request");
    expect(metered.usage).toEqual({ promptTokens: 150, completionTokens: 10 });
    const silent = await fixture.service.runTurn(session("silent"), "request");
    expect(silent.usage).toBeUndefined();
  });

  // ATO-277: after a fallover, message_sent names the provider and model
  // that answered, not the configured active ones.
  it("telemetry reports the provider that served the turn and its fallbacks", async () => {
    const registry = fixture.providers.providerRegistry;
    const active = registry.activeText;
    const backup = { ...active, id: "backup", name: "backup-service" } as typeof active;
    const getProvider = registry.getProvider.bind(registry);
    vi.spyOn(registry, "getProvider").mockImplementation((id) => (id === "backup" ? backup : getProvider(id)));
    const meter = fixture.deps.telemetry.turnUsageMeter;
    fixture.loop.runTurn.mockImplementationOnce(async (value, options) => {
      meter.recordServed(value.id, "backup");
      meter.record({ sessionId: value.id, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4 } });
      return result(value, options);
    });
    const service = createRuntimeTurnService(fixture.config, {
      ...fixture.deps,
      inference: {
        ...fixture.deps.inference,
        resolveActiveModelName: (providerId?: string) => (providerId === "backup" ? "backup-model" : "active-model"),
      },
    });
    const capture = vi.spyOn(analytics, "captureMessageSent");
    await service.runTurn(session("served"), "request");
    expect(capture).toHaveBeenCalledWith(null, fixture.deps.telemetry.analyticsStateStore, expect.objectContaining({
      provider: "backup-service",
      model: "backup-model",
      fallbackCalls: 1,
      cachedTokens: 4,
    }));
    const context = capture.mock.calls[0]![2];
    expect(context).not.toHaveProperty("servedProviderId");
  });

  it("telemetry falls back to the intended provider when nothing was served", async () => {
    const capture = vi.spyOn(analytics, "captureMessageSent");
    await fixture.service.runTurn(session("quiet"), "request");
    expect(capture).toHaveBeenCalledWith(null, fixture.deps.telemetry.analyticsStateStore, expect.objectContaining({
      provider: fixture.providers.providerRegistry.activeText.name,
    }));
    expect(capture.mock.calls[0]![2]).not.toHaveProperty("fallbackCalls");
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

  it("suggests a next step after an answered turn only when the setting is on (ATO-1093)", async () => {
    const calls = vi.fn(async () => completion("Add tests for the parser"));
    fixture.deps.execution.llmComplete = calls;
    const emitted: Array<[string, unknown]> = [];
    fixture.deps.emitEvent = (id, event) => { emitted.push([id, event]); };
    let service = createRuntimeTurnService(fixture.config, fixture.deps);
    await service.executeTurn(session("off"), "request");
    await flushNaming();
    expect(calls).not.toHaveBeenCalled();

    (fixture.config.tui as unknown as { nextStepSuggestions: boolean }).nextStepSuggestions = true;
    service = createRuntimeTurnService(fixture.config, fixture.deps);
    const output = await service.executeTurn(session("on"), "request");
    await flushNaming(); await flushNaming();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(fixture.rows.get(output.session.id)?.metadata?.nextStep).toMatchObject({ text: "Add tests for the parser" });
    expect(emitted).toEqual([["on", { type: "next_step_suggestion", text: "Add tests for the parser" }]]);
    expect(fixture.state.pendingSessionNamings.size).toBe(0);
  });

  it("makes no naming call after a turn that stopped for money (ATO-1350)", async () => {
    vi.useFakeTimers(); fixture.config.agent.nameSessions = true;
    const naming = vi.fn(async () => completion("Generated title"));
    fixture.deps.execution.llmComplete = naming;
    const service = createRuntimeTurnService(fixture.config, fixture.deps);
    for (const stopCause of ["cost_ceiling", "credit_exhausted"] as const) {
      fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) =>
        ({ ...result(value, options), stopCause }));
      const output = await service.executeTurn(session(`broke-${stopCause}`), "request");
      await flushNaming();
      expect(fixture.state.pendingSessionNamings.size).toBe(0);
      expect(fixture.rows.get(output.session.id)?.metadata?.title).toBeUndefined();
    }
    expect(naming).not.toHaveBeenCalled();
    // The same first turn stopped by time still gets its title call.
    fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) =>
      ({ ...result(value, options), stopCause: "time_ceiling" }));
    await service.executeTurn(session("timed-out"), "request");
    await flushNaming();
    expect(naming).toHaveBeenCalledTimes(1);
  });

  it("session hooks: hook context reaches the loop, a Stop block runs it again, a blocked prompt saves nothing (ATO-2198)", async () => {
    const afterTurn = vi.fn(async () => undefined as string | undefined).mockResolvedValueOnce("tests are red");
    const beforeTurn = vi.fn(async () => ({ kind: "proceed" as const, sessionContext: "project: atomic", context: "on branch main" }));
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, sessionHooks: { beforeTurn, afterTurn } });
    const output = await service.executeTurn(session("hooked"), "request");
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(2);
    expect(fixture.loop.runTurn.mock.calls[0]?.[1]).toMatchObject({ userMessage: "request", hookContext: "on branch main", sessionHookContext: "project: atomic" });
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]?.userMessage).toContain("tests are red");
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).not.toHaveProperty("hookContext");
    expect(fixture.loop.runTurn.mock.calls[1]?.[1]).toMatchObject({ sessionHookContext: "project: atomic" });
    expect(output.stepCount).toBe(2);
    expect(fixture.rows.get("hooked")).toBe(output.session);

    fixture.events.length = 0;
    const blocking = createRuntimeTurnService(fixture.config, {
      ...fixture.deps,
      sessionHooks: { beforeTurn: async () => ({ kind: "blocked" as const, reason: "no secrets" }), afterTurn },
    });
    await expect(blocking.executeTurn(session("refused"), "my key")).rejects.toThrow("no secrets");
    expect(fixture.events).toEqual([]);
    expect(fixture.rows.has("refused")).toBe(false);
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(2);
  });

  it("SessionStart text from the real engine still reaches turn 2; UserPromptSubmit text does not carry over (ATO-2198)", async () => {
    let prompts = 0;
    const engine = new SessionHookEngine({
      stateDir: dir,
      load: () => parseHooksObject({ hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "start" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "ctx" }] }],
      } }, { kind: "user", file: join(dir, "hooks.json") }),
      run: async (hook) => ({ exitCode: 0, stdout: hook.command === "start" ? "project: atomic" : `prompt ${++prompts}`, stderr: "", timedOut: false, durationMs: 1 }),
    });
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, sessionHooks: engine });
    const first = await service.executeTurn(session("kept"), "one");
    await service.executeTurn(first.session, "two");
    const second = fixture.loop.runTurn.mock.calls.at(-1)?.[1];
    expect(second).toMatchObject({ userMessage: "two", sessionHookContext: "project: atomic", hookContext: "prompt 2" });
  });

  it("subagent turns run no session hooks (ATO-2198)", async () => {
    const beforeTurn = vi.fn(async () => ({ kind: "proceed" as const }));
    const afterTurn = vi.fn(async () => "more" as string | undefined);
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, sessionHooks: { beforeTurn, afterTurn } });
    await service.executeTurn(session("sub"), "brief", { origin: "subagent" });
    expect(beforeTurn).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
    expect(fixture.loop.runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("stoppedForMoney (ATO-1350)", () => {
  it("is true only when the budget or the provider credit ended the turn", () => {
    expect(stoppedForMoney("cost_ceiling")).toBe(true);
    expect(stoppedForMoney("credit_exhausted")).toBe(true);
    expect(stoppedForMoney("time_ceiling")).toBe(false);
    expect(stoppedForMoney("step_ceiling")).toBe(false);
    expect(stoppedForMoney("no_progress")).toBe(false);
    expect(stoppedForMoney(undefined)).toBe(false);
  });
});
