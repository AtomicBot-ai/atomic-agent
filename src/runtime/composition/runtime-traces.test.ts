import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { TraceEvent } from "../../tracing/trace/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { createRuntimeTraces } from "./runtime-traces.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

describe("runtime trace ownership and deferred event routing", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "atomic-runtime-traces-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigCache();
    await rm(stateDir, { recursive: true, force: true });
  });

  function fixture(enabled: boolean | null = true, traceDefault?: boolean) {
    const config = getConfig();
    config.tracing.trace.enabled = enabled;
    const events: TraceEvent[] = [];
    const traces = createRuntimeTraces(config, {
      traceDefault, handlers: { traceSinks: [(event) => { events.push(event); }] },
    }, logger);
    const session = (id: string) => createEmptySessionState({ id, workingDir: stateDir });
    return { traces, events, session };
  }

  it("keeps explicit trace disable above an entrypoint default and allocates no recorder file", async () => {
    const { traces, session } = fixture(false, true);
    expect(traces.traceBus).toBeNull();
    expect(traces.ensureRecorder(session("disabled"))).toBeNull();
    expect(await readdir(stateDir)).not.toContain("traces");
    expect(fixture(null, true).traces.traceBus).not.toBeNull();
  });

  it("starts a newly opened trace with current-turn metadata without mutating stored stamps", () => {
    const { traces, events, session } = fixture();
    const stored = { ...session("switched"), metadata: { llm: { providerId: "old", chatModel: "old-model" } } };
    const headerMetadata = { llm: { providerId: "new", chatModel: "new-model" } };
    traces.ensureRecorder(stored, headerMetadata);
    const started = events.find((event) => event.type === "session_started");
    expect(started?.type).toBe("session_started");
    if (started?.type === "session_started") expect(started.metadata).toEqual(headerMetadata);
    expect(stored.metadata.llm.providerId).toBe("old");
  });

  it("tests the actual bounded LRU owner rather than an independently reimplemented map", () => {
    const { traces, session } = fixture();
    const oldest = traces.ensureRecorder(session("oldest"));
    traces.ensureRecorder(session("next-oldest"));
    for (let i = 0; i < 62; i++) traces.ensureRecorder(session(`s-${i}`));
    expect(traces.touchRecorder("oldest")).toBe(oldest);
    const newest = traces.ensureRecorder(session("newest"));
    expect(traces.touchRecorder("next-oldest")).toBeUndefined();
    expect(traces.touchRecorder("oldest")).toBe(oldest);
    expect(traces.touchRecorder("newest")).toBe(newest);
  });

  it("preserves active recorder identity through over-cap bursts and defers deletion until release", () => {
    const { traces, events, session } = fixture();
    const active = traces.ensureRecorder(session("active"));
    traces.pinSession("active");
    traces.dropRecorder("active");
    for (let i = 0; i < 70; i++) traces.ensureRecorder(session(`burst-${i}`));
    expect(traces.ensureRecorder(session("active"))).toBe(active);
    expect(events.filter((event) => event.type === "session_started" && event.sessionId === "active")).toHaveLength(1);
    traces.releaseSession("active");
    expect(traces.touchRecorder("active")).toBeUndefined();
  });

  it("exempts each new entry while every prior recorder is pinned", () => {
    const { traces, session } = fixture();
    for (let i = 0; i < 64; i++) {
      const id = `pinned-${i}`;
      traces.ensureRecorder(session(id));
      traces.pinSession(id);
    }
    const created = traces.ensureRecorder(session("new"));
    expect(traces.touchRecorder("new")).toBe(created);
    traces.pinSession("new");
    traces.releaseSession("pinned-0");
    expect(traces.touchRecorder("pinned-0")).toBeUndefined();
    expect(traces.touchRecorder("new")).toBe(created);
  });

  it("routes concurrent ALS frames separately and permits explicit parent events inside a worker frame", async () => {
    const { traces } = fixture();
    const calls: string[] = [];
    const reporter = vi.fn(() => null);
    const routing = traces.createEventRouting({ emit: (id) => { calls.push(`hook:${id}`); } }, {
      handlers: { onAgentEvent: (_event, id) => { calls.push(`host:${id}`); } },
    }, reporter);
    const event: AgentLoopEvent = { type: "turn_started", turnIndex: 0 };
    await Promise.all(["a", "b"].map((id) => traces.turnContext.run({ sessionId: id }, async () => {
      routing.emitAgentLoopEvent(event);
      await Promise.resolve();
      routing.emitAgentLoopEvent(event);
    })));
    expect(calls).toEqual(["hook:a", "host:a", "hook:b", "host:b", "hook:a", "host:a", "hook:b", "host:b"]);
    traces.turnContext.run({ sessionId: "worker" }, () => routing.emitAgentLoopEventFor("parent", event));
    expect(calls.slice(-2)).toEqual(["hook:parent", "host:parent"]);
    expect(reporter).not.toHaveBeenCalled();
  });

  it("keeps hook-before-usage-before-host order and does not leak usage after its separate clear", () => {
    const { traces, session } = fixture();
    const state = session("usage");
    const prompt = buildPrompt({
      session: state, toolDescriptors: [], skillCatalog: [],
      capabilities: {
        platform: process.platform, arch: process.arch, browserChannel: "chrome", workingDir: stateDir,
        hasClipboard: false, hasWmctrl: false, hasNotifications: false,
      },
    });
    const observations: (number | null | undefined)[] = [];
    const options: Pick<CreateAgentRuntimeOptions, "handlers"> = {
      handlers: { onAgentEvent: () => { observations.push(traces.readContextUsage("usage")?.tokens); } },
    };
    const routing = traces.createEventRouting({ emit: () => { observations.push(traces.readContextUsage("usage")?.tokens); } }, options, () => null);
    routing.emitAgentLoopEventFor("usage", { type: "llm_event", event: { type: "prompt_built", prompt, slotId: -1 } });
    expect(observations).toEqual([undefined, prompt.tokens.total]);
    routing.emitAgentLoopEventFor("usage", { type: "llm_event", event: {
      type: "llm_completed", completion: {
        content: "", reasoningContent: "", stop: true, truncated: false, cacheHitTokens: 0, slotId: -1, modelId: null,
        timing: { promptMs: 0, predictedMs: 0, promptTokens: 123, predictedTokens: 0 },
      },
    } });
    expect(observations.slice(-2)).toEqual([prompt.tokens.total, 123]);
    traces.clearContextUsage("usage");
    expect(traces.readContextUsage("usage")).toBeUndefined();
    options.handlers = { onAgentEvent: () => { observations.push(999); } };
    routing.emitAgentLoopEventFor("usage", { type: "turn_started", turnIndex: 1 });
    expect(observations.at(-1)).toBe(999);
  });

  it("resolves the error reporter at failure time and still delivers unattributed host events", () => {
    const { traces } = fixture();
    const getter = vi.fn(() => null);
    const host = vi.fn();
    const hook = vi.fn();
    const routing = traces.createEventRouting({ emit: hook }, { handlers: { onAgentEvent: host } }, getter);
    const event: AgentLoopEvent = { type: "loop_failed", error: new Error("synthetic failure"), category: "transport" };
    routing.emitAgentLoopEventFor(undefined, event);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(hook).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledWith(event, undefined);
  });
});
