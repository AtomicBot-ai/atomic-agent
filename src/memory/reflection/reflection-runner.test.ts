import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import { MetricsCollector } from "../../telemetry/metrics-collector.js";
import { AgentMetrics } from "../../telemetry/agent-metrics.js";
import { StructuredLogger } from "../../telemetry/structured-logger.js";

import { MemoryStore } from "../memory-store.js";
import { ProfileStore } from "../profile-store.js";

import { REFLECTION_GRAMMAR } from "./reflection-grammar.js";
import { REFLECTION_STABLE_PREFIX } from "./reflection-prompt.js";
import { createReflectionRunner } from "./reflection-runner.js";

function completion(content: string, slotId = 7): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 0,
      predictedTokens: 0,
    },
    cacheHitTokens: 0,
    slotId,
    modelId: null,
  };
}

interface MetricEntry {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

interface LogEntry {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

interface Harness {
  dir: string;
  store: ProfileStore;
  notesStore: MemoryStore;
  metricEvents: MetricEntry[];
  logEvents: LogEntry[];
  metrics: AgentMetrics;
  logger: StructuredLogger;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "reflect-runner-"));
  const dbFile = join(dir, "memory.sqlite");
  const store = new ProfileStore({ dbFile });
  const notesStore = new MemoryStore({ dbFile, maxEntries: 100 });
  const metricEvents: MetricEntry[] = [];
  const collector = new MetricsCollector({
    sinks: [
      (event) =>
        metricEvents.push({
          name: event.name,
          value: event.value,
          tags: event.tags as Record<string, string> | undefined,
        }),
    ],
  });
  const metrics = new AgentMetrics(collector);
  const logEvents: LogEntry[] = [];
  const logger = new StructuredLogger({
    level: "debug",
    sinks: [
      (record) =>
        logEvents.push({
          level: record.level,
          message: record.message,
          context: record.context as Record<string, unknown> | undefined,
        }),
    ],
  });
  return {
    dir,
    store,
    notesStore,
    metricEvents,
    logEvents,
    metrics,
    logger,
    dispose() {
      notesStore.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("createReflectionRunner", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.dispose();
  });

  it("writes parsed SET facts into the profile store and records an `ok` outcome", async () => {
    const calls: Array<{ prompt: string; grammar: string; slotId: number; sessionId: string }> = [];
    const runner = createReflectionRunner({
      llmComplete: async (params) => {
        calls.push({
          prompt: params.prompt,
          grammar: params.grammar,
          slotId: params.slotId,
          sessionId: params.sessionId,
        });
        return completion("SET name=Alex\nSET timezone=Europe/Lisbon\n");
      },
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "I live in Lisbon and my name is Alex",
      assistantReply: "Noted!",
    });

    expect(h.store.list().map((f) => `${f.key}=${f.value}`)).toEqual([
      "name=Alex",
      "timezone=Europe/Lisbon",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.grammar).toBe(REFLECTION_GRAMMAR);
    expect(calls[0]!.slotId).toBe(7);
    expect(calls[0]!.sessionId).toBe("reflection:s1");
    expect(calls[0]!.prompt.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);

    const reflectionCounters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(reflectionCounters).toHaveLength(1);
    expect(reflectionCounters[0]!.tags?.outcome).toBe("ok");
    const latency = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection.latency_ms",
    );
    expect(latency).toHaveLength(1);

    expect(h.logEvents.some((e) => e.message === "reflection.ok")).toBe(true);
  });

  it("records `none` when the model returns NONE", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("NONE\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "hi",
      assistantReply: "hello",
    });

    expect(h.store.list()).toHaveLength(0);
    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("none");
  });

  it("clamps writes to `maxFactsPerCall`", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET a=1\nSET b=2\nSET c=3\nSET d=4\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 2,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.store.list().map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("skips a fact that fails ProfileStore validation without failing the whole call", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET bad@key=oops\nSET ok=fine\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.store.list().map((f) => f.key)).toEqual(["ok"]);
    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("ok");
  });

  it("records `failed` when llmComplete throws and does not re-throw", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => {
        throw new Error("llama-server exploded");
      },
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await expect(
      runner.reflect({ sessionId: "s1", userMessage: "u", assistantReply: "a" }),
    ).resolves.toBeUndefined();

    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("failed");
    expect(h.store.list()).toHaveLength(0);
  });

  it("records `timeout` when the completion exceeds `timeoutMs`", async () => {
    const runner = createReflectionRunner({
      llmComplete: async (params) =>
        new Promise<CompletionResult>((_, reject) => {
          params.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 10,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("timeout");
  });

  it("aborts the in-flight reflection when reflect() is called again", async () => {
    const aborted: string[] = [];
    let resolveSecond: ((r: CompletionResult) => void) | null = null;
    const runner = createReflectionRunner({
      llmComplete: async (params) => {
        if (params.sessionId === "reflection:s1") {
          return new Promise<CompletionResult>((_, reject) => {
            params.signal.addEventListener("abort", () => {
              aborted.push("s1");
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return new Promise<CompletionResult>((resolve) => {
          resolveSecond = resolve;
        });
      },
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 60_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    const firstPromise = runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });
    const secondPromise = runner.reflect({
      sessionId: "s2",
      userMessage: "u2",
      assistantReply: "a2",
    });

    await firstPromise;
    expect(aborted).toEqual(["s1"]);

    resolveSecond?.(completion("NONE\n"));
    await secondPromise;

    const outcomes = h.metricEvents
      .filter((e) => e.name === "agent.memory.reflection")
      .map((e) => e.tags?.outcome);
    expect(outcomes).toEqual(["aborted", "none"]);
  });

  it("mirrors NOTE lines into the MemoryStore with a `reflection` tag", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion(
          [
            "SET name=Alex",
            "NOTE project uses pnpm [tags=tooling]",
            "NOTE prefer terse replies",
          ].join("\n") + "\n",
        ),
      profileStore: h.store,
      memoryStore: h.notesStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "remember this",
      assistantReply: "ok",
    });

    expect(h.store.list().map((f) => f.key)).toEqual(["name"]);
    const notes = h.notesStore.list();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.content).sort()).toEqual([
      "prefer terse replies",
      "project uses pnpm",
    ]);
    for (const note of notes) {
      expect(note.tags).toContain("reflection");
      expect(note.sessionId).toBe("s1");
    }
    const withTool = notes.find((n) => n.content === "project uses pnpm");
    expect(withTool?.tags).toContain("tooling");

    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("ok");
  });

  it("records `ok` when only NOTE lines land and no SET facts are present", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("NOTE lone observation worth keeping\n"),
      profileStore: h.store,
      memoryStore: h.notesStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.store.list()).toHaveLength(0);
    expect(h.notesStore.list()).toHaveLength(1);
    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("ok");
  });

  it("clamps NOTE writes to `maxNotesPerCall`", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion(
          ["NOTE a", "NOTE b", "NOTE c", "NOTE d"].join("\n") + "\n",
        ),
      profileStore: h.store,
      memoryStore: h.notesStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 2,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.notesStore.list()).toHaveLength(2);
  });

  it("skips NOTE extraction entirely when memoryStore is not wired", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET name=Alex\nNOTE ignored since store missing\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.store.list().map((f) => f.key)).toEqual(["name"]);
    expect(h.notesStore.list()).toHaveLength(0);
  });

  it("records `none` when NOTE is the only channel but maxNotesPerCall=0", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("NOTE would be dropped\n"),
      profileStore: h.store,
      memoryStore: h.notesStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 0,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });

    expect(h.notesStore.list()).toHaveLength(0);
    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("none");
  });

  it("abortPending() aborts the in-flight reflection", async () => {
    const runner = createReflectionRunner({
      llmComplete: async (params) =>
        new Promise<CompletionResult>((_, reject) => {
          params.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 60_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    const promise = runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
    });
    runner.abortPending();
    await promise;

    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("aborted");
  });
});
