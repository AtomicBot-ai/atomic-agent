import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

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
  const store = new ProfileStore({ dbFile, metrics });
  const notesStore = new MemoryStore({ dbFile, maxEntries: 100 });
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
    const calls: Array<{
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId: string;
    }> = [];
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

  it("emits an `ok` trace event with write counts via emitTrace", async () => {
    const traced: Array<{
      sessionId: string;
      outcome: string;
      factsWritten?: number;
      notesWritten?: number;
    }> = [];
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET name=Alex\nSET timezone=Europe/Lisbon\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
      emitTrace: (event) => traced.push(event),
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "I am Alex in Lisbon",
      assistantReply: "Noted!",
    });

    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({
      sessionId: "s1",
      outcome: "ok",
      factsWritten: 2,
    });
  });

  it("emits a `none` trace event when the model returns NONE", async () => {
    const traced: Array<{ sessionId: string; outcome: string }> = [];
    const runner = createReflectionRunner({
      llmComplete: async () => completion("NONE\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
      emitTrace: (event) => traced.push(event),
    });

    await runner.reflect({
      sessionId: "s1",
      // Not a bare greeting: that window is skipped as trivial before
      // the model is asked, and this test pins the model's NONE path.
      userMessage: "what is the capital of France?",
      assistantReply: "Paris.",
    });

    expect(traced).toEqual([{ sessionId: "s1", outcome: "none" }]);
  });

  it("swallows an emitTrace failure without derailing reflection", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("SET name=Alex\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
      emitTrace: () => {
        throw new Error("sink down");
      },
    });

    await expect(
      runner.reflect({
        sessionId: "s1",
        userMessage: "I am Alex",
        assistantReply: "ok",
      }),
    ).resolves.toBeUndefined();
    expect(h.store.list().map((f) => f.key)).toEqual(["name"]);
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
      userMessage: "what is the capital of France?",
      assistantReply: "Paris.",
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
      llmComplete: async () => completion("SET bad@key=oops\nSET ok=fine\n"),
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
      runner.reflect({
        sessionId: "s1",
        userMessage: "u",
        assistantReply: "a",
      }),
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

  it("aborts the in-flight reflection when reflect() is called again on the same session", async () => {
    const aborted: string[] = [];
    let callIndex = 0;
    let resolveSecond: ((r: CompletionResult) => void) | null = null;
    const runner = createReflectionRunner({
      llmComplete: async (params) => {
        callIndex += 1;
        if (callIndex === 1) {
          return new Promise<CompletionResult>((_, reject) => {
            params.signal.addEventListener("abort", () => {
              aborted.push("first");
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
      sessionId: "s1",
      userMessage: "u2",
      assistantReply: "a2",
    });

    await firstPromise;
    expect(aborted).toEqual(["first"]);

    resolveSecond?.(completion("NONE\n"));
    await secondPromise;

    const outcomes = h.metricEvents
      .filter((e) => e.name === "agent.memory.reflection")
      .map((e) => e.tags?.outcome);
    expect(outcomes).toEqual(["aborted", "none"]);
  });

  it("does not abort a reflection on session A when session B fires its own reflect()", async () => {
    let resolveA: ((r: CompletionResult) => void) | null = null;
    let resolveB: ((r: CompletionResult) => void) | null = null;
    const aborted: string[] = [];
    const runner = createReflectionRunner({
      llmComplete: async (params) => {
        params.signal.addEventListener("abort", () => {
          aborted.push(params.sessionId);
        });
        if (params.sessionId === "reflection:sA") {
          return new Promise<CompletionResult>((resolve) => {
            resolveA = resolve;
          });
        }
        return new Promise<CompletionResult>((resolve) => {
          resolveB = resolve;
        });
      },
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 60_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    const promiseA = runner.reflect({
      sessionId: "sA",
      userMessage: "uA",
      assistantReply: "aA",
    });
    const promiseB = runner.reflect({
      sessionId: "sB",
      userMessage: "uB",
      assistantReply: "aB",
    });

    expect(aborted).toEqual([]);

    resolveA?.(completion("SET ka=va\n"));
    resolveB?.(completion("SET kb=vb\n"));
    await Promise.all([promiseA, promiseB]);

    expect(aborted).toEqual([]);
    const outcomes = h.metricEvents
      .filter((e) => e.name === "agent.memory.reflection")
      .map((e) => e.tags?.outcome);
    expect(outcomes.sort()).toEqual(["ok", "ok"]);
  });

  it("abortPending({ sessionId }) aborts only the matching session", async () => {
    let resolveB: ((r: CompletionResult) => void) | null = null;
    const aborted: string[] = [];
    const runner = createReflectionRunner({
      llmComplete: async (params) => {
        if (params.sessionId === "reflection:sA") {
          return new Promise<CompletionResult>((_, reject) => {
            params.signal.addEventListener("abort", () => {
              aborted.push("sA");
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return new Promise<CompletionResult>((resolve) => {
          params.signal.addEventListener("abort", () => {
            aborted.push("sB");
          });
          resolveB = resolve;
        });
      },
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 60_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    const promiseA = runner.reflect({
      sessionId: "sA",
      userMessage: "uA",
      assistantReply: "aA",
    });
    const promiseB = runner.reflect({
      sessionId: "sB",
      userMessage: "uB",
      assistantReply: "aB",
    });

    runner.abortPending({ sessionId: "sA" });
    await promiseA;
    expect(aborted).toEqual(["sA"]);

    resolveB?.(completion("NONE\n"));
    await promiseB;
    expect(aborted).toEqual(["sA"]);
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
      // The name has to come from the user: the grounding guard drops
      // a `name` fact the user never typed.
      userMessage: "remember this, my name is Alex",
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
      llmComplete: async () =>
        completion("NOTE lone observation worth keeping\n"),
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
        completion(["NOTE a", "NOTE b", "NOTE c", "NOTE d"].join("\n") + "\n"),
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
      userMessage: "my name is Alex",
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

  // Memory-v2 phase 4. Bi-temporal end-to-end: SET with the
  // [valid_from=now; supersedes=KEY] marker flows from the parser
  // through `writeFacts` into `ProfileStore.set`, preserving the
  // previous active row as a superseded version of the chain.
  it("scenario 4.A — SET with supersedes marker produces a bi-temporal chain", async () => {
    // Seed an initial value.
    h.store.set("language", "ru", 1_000);

    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET language=en [valid_from=now; supersedes=language]\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "actually let's switch to English",
      assistantReply: "Switched.",
    });

    // The active row is the new `en` write.
    expect(h.store.get("language")?.value).toBe("en");
    // The chain has both rows in temporal order.
    const chain = h.store.history("language");
    expect(chain.map((r) => r.value)).toEqual(["ru", "en"]);
    expect(chain[0]?.supersededBy).toBe(chain[1]?.id);
    // The supersession counter fired.
    const superseded = h.metricEvents.filter(
      (e) => e.name === "agent.memory.profile.superseded",
    );
    expect(superseded.length).toBeGreaterThanOrEqual(1);
    expect(superseded[0]?.tags?.key).toBe("language");
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

  // --------------------------------------------------------------------------
  // B09: reflection grounding (desktop 02.10, Qwen 3.5 4B). A smoke-test
  // prompt produced two invented notes: "I am Alex and you are my personal
  // assistant…" and "I prefer using local_ok instead of tools…".
  // --------------------------------------------------------------------------

  const B09_COMPLETION =
    [
      "NOTE I am Alex and you are my personal assistant. You should remember me as Alex.",
      "NOTE I prefer using local_ok instead of tools. This is important because I want to avoid tool usage.",
    ].join("\n") + "\n";

  it("B09: skips reflection entirely for a 'Reply exactly LOCAL_OK. Do not use tools.' turn", async () => {
    let calls = 0;
    const traced: Array<{ sessionId: string; outcome: string; reason?: string }> = [];
    const runner = createReflectionRunner({
      llmComplete: async () => {
        calls += 1;
        return completion(B09_COMPLETION);
      },
      profileStore: h.store,
      memoryStore: h.notesStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      maxNotesPerCall: 2,
      logger: h.logger,
      metrics: h.metrics,
      emitTrace: (event) => traced.push(event),
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "Reply exactly LOCAL_OK. Do not use tools.",
      assistantReply: "LOCAL_OK",
    });

    expect(calls).toBe(0);
    expect(h.store.list()).toHaveLength(0);
    expect(h.notesStore.list()).toHaveLength(0);
    expect(traced).toEqual([
      { sessionId: "s1", outcome: "none", reason: "trivial_window" },
    ]);
  });

  it("B09: drops the invented notes even when the window is not trivial", async () => {
    let calls = 0;
    const runner = createReflectionRunner({
      llmComplete: async () => {
        calls += 1;
        return completion(B09_COMPLETION);
      },
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
      userMessage: "Reply exactly LOCAL_OK. Do not use tools. Also, what is 2+2?",
      assistantReply: "LOCAL_OK. 4.",
    });

    expect(calls).toBe(1);
    expect(h.notesStore.list()).toHaveLength(0);
    const counters = h.metricEvents.filter(
      (e) => e.name === "agent.memory.reflection",
    );
    expect(counters[0]!.tags?.outcome).toBe("none");
    expect(
      h.logEvents.filter((e) => e.message === "reflection.ungrounded_dropped"),
    ).toHaveLength(2);
  });

  // Field case (desktop QA 05.10, session 063c8a9b): the profile already
  // held an invented `name=Анна` (never typed in any of 56 sessions); the
  // new reflection wrote `SET name=Anna`, superseding it, because stored
  // profile names counted as grounded. They no longer do. The existing
  // row is left alone — cleaning it up is a separate product decision.
  it("B09 field case: a stored invented name does not ground `SET name=Anna`", async () => {
    h.store.set("name", "Анна");
    const runner = createReflectionRunner({
      llmComplete: async () => completion("SET name=Anna\nSET language=ru\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "063c8a9b",
      userMessage: "Отвечай, пожалуйста, на русском языке",
      assistantReply: "Хорошо, буду отвечать на русском.",
    });

    expect(h.store.get("name")?.value).toBe("Анна");
    expect(h.store.history("name")).toHaveLength(1);
    expect(h.store.get("language")?.value).toBe("ru");
    expect(
      h.logEvents.filter((e) => e.message === "reflection.ungrounded_dropped"),
    ).toHaveLength(1);
  });

  it("B09: keeps a legit 'my name is Nadia' + 'remember I prefer TypeScript' session", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion(
          "SET name=Nadia\nNOTE The user prefers TypeScript for new projects [tags=lang]\n",
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
      userMessage: "Remember that I prefer TypeScript for new projects.",
      assistantReply: "Noted.",
      transcript: [
        { user: "My name is Nadia.", assistant: "Nice to meet you, Nadia!" },
        {
          user: "Remember that I prefer TypeScript for new projects.",
          assistant: "Noted.",
        },
      ],
    });

    expect(h.store.list().map((f) => `${f.key}=${f.value}`)).toEqual([
      "name=Nadia",
    ]);
    // ATO-199: stamped as checked, so it reaches `### profile` at once.
    expect(h.store.get("name")?.nameGrounding).toBe("grounded");
    expect(h.store.listForPrompt().map((f) => f.key)).toEqual(["name"]);
    expect(h.notesStore.list().map((n) => n.content)).toEqual([
      "The user prefers TypeScript for new projects",
    ]);
  });

  it("B09: drops a name fact the user never typed but keeps the rest of the batch", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("SET name=Alex\nSET timezone=Europe/Lisbon\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "Please use Europe/Lisbon as my timezone",
      assistantReply: "Done.",
    });

    expect(h.store.list().map((f) => `${f.key}=${f.value}`)).toEqual([
      "timezone=Europe/Lisbon",
    ]);
  });

  // ATO-201: a name the user only confirmed ("Тебя зовут Алекс?" — "да")
  // is theirs; the window's own naming question vouches for it.
  it("ATO-201: writes a name the user confirmed with a bare yes", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("SET name=Alex\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "да",
      assistantReply: "Отлично, запомню.",
      transcript: [
        { user: "привет", assistant: "Привет! Тебя зовут Алекс?" },
        { user: "да", assistant: "Отлично, запомню." },
      ],
    });

    expect(h.store.get("name")).toMatchObject({ value: "Alex", nameGrounding: "grounded" });
  });

  it("ATO-201: keeps a late-turn note naming the user from earlier in the session", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("NOTE I am Nadia and I moved to Lisbon\n"),
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
      userMessage: "Я переехала в Лиссабон",
      assistantReply: "Поздравляю!",
      groundingTexts: ["Меня зовут Надя", "Я переехала в Лиссабон"],
    });

    expect(h.notesStore.list().map((n) => n.content)).toEqual([
      "I am Nadia and I moved to Lisbon",
    ]);
  });

  it("ATO-201: a checked profile name vouches for a note; an unchecked one does not", async () => {
    h.store.set("first_name", "Надя", { nameGrounding: "grounded" });
    h.store.set("name", "Анна");
    const runner = createReflectionRunner({
      llmComplete: async () =>
        completion("NOTE The user is Nadia and likes short answers\nNOTE The user is Anna and likes tea\n"),
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
      userMessage: "Отвечай короче, и я люблю чай",
      assistantReply: "Хорошо.",
    });

    expect(h.notesStore.list().map((n) => n.content)).toEqual([
      "The user is Nadia and likes short answers",
    ]);
  });

  it("ATO-201: logs a dropped item at info with a short reason and never its text", async () => {
    const runner = createReflectionRunner({
      llmComplete: async () => completion("SET name=Анна\nSET language=ru\n"),
      profileStore: h.store,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxFactsPerCall: 3,
      logger: h.logger,
      metrics: h.metrics,
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "Отвечай на русском",
      assistantReply: "Хорошо.",
    });

    const drops = h.logEvents.filter((e) => e.message === "reflection.ungrounded_dropped");
    expect(drops).toHaveLength(1);
    expect(drops[0]!.level).toBe("info");
    expect(drops[0]!.context).toMatchObject({
      kind: "fact",
      reason: "ungrounded_identity",
      detail: "names the user by a name the user never wrote",
    });
    expect(JSON.stringify(drops[0]!.context)).not.toContain("Анна");
  });
});
