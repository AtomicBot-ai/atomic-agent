import { describe, it, expect } from "vitest";
import { StructuredLogger } from "./structured-logger.js";
import { MetricsCollector } from "./metrics-collector.js";
import { AgentMetrics, METRIC_NAMES } from "./agent-metrics.js";
import { createLogNdjsonSink, createMetricNdjsonSink } from "./ndjson-sinks.js";
import type { SidecarEvent, LogPayload, MetricPayload } from "../sidecar/sidecar-events.js";

describe("StructuredLogger", () => {
  it("respects the configured level threshold", () => {
    const records: string[] = [];
    const logger = new StructuredLogger({
      level: "warn",
      sinks: [(r) => records.push(`${r.level}:${r.message}`)],
    });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records).toEqual(["warn:w", "error:e"]);
  });

  it("routes context untouched to sinks", () => {
    const received: Record<string, unknown>[] = [];
    const logger = new StructuredLogger({
      level: "debug",
      sinks: [(r) => received.push(r.context ?? {})],
    });
    logger.info("hi", { sessionId: "s1", tool: "grep" });
    expect(received[0]).toEqual({ sessionId: "s1", tool: "grep" });
  });
});

describe("MetricsCollector + AgentMetrics", () => {
  it("records canonical step/llm/tool metric names", () => {
    const samples: Array<{ name: string; value: number; tags?: Record<string, string> }> = [];
    const collector = new MetricsCollector({
      sinks: [(s) => samples.push({ name: s.name, value: s.value, ...(s.tags ? { tags: s.tags } : {}) })],
    });
    const metrics = new AgentMetrics(collector);

    metrics.recordStep({
      sessionId: "s",
      stepIndex: 0,
      tokensUsed: 1200,
      durationMs: 840,
      outcome: "ok",
    });
    metrics.recordLlmCall({
      sessionId: "s",
      promptTokens: 2100,
      completionTokens: 300,
      durationMs: 640,
      cacheReused: true,
    });
    metrics.recordTool({
      sessionId: "s",
      tool: "grep",
      status: "ok",
      durationMs: 10,
    });
    metrics.recordTool({
      sessionId: "s",
      tool: "apply_patch",
      status: "error",
      durationMs: 12,
    });

    const names = samples.map((s) => s.name);
    expect(names).toContain(METRIC_NAMES.stepTokens);
    expect(names).toContain(METRIC_NAMES.stepDuration);
    expect(names).toContain(METRIC_NAMES.stepOutcome);
    expect(names).toContain(METRIC_NAMES.llmLatency);
    expect(names).toContain(METRIC_NAMES.llmPromptTokens);
    expect(names).toContain(METRIC_NAMES.llmCompletionTokens);
    expect(names).toContain(METRIC_NAMES.kvCacheHit);
    expect(names).toContain(METRIC_NAMES.toolCall);
    expect(names).toContain(METRIC_NAMES.toolSuccess);
    expect(names).toContain(METRIC_NAMES.toolFailure);
  });

  it("records kv cache hits as a 1-valued counter when reused", () => {
    const samples: Array<{ name: string; value: number }> = [];
    const collector = new MetricsCollector({
      sinks: [(s) => samples.push({ name: s.name, value: s.value })],
    });
    const metrics = new AgentMetrics(collector);
    metrics.recordLlmCall({
      sessionId: "s",
      promptTokens: 10,
      completionTokens: 5,
      durationMs: 1,
      cacheReused: true,
    });
    metrics.recordLlmCall({
      sessionId: "s",
      promptTokens: 20,
      completionTokens: 7,
      durationMs: 2,
      cacheReused: false,
    });
    const hitSamples = samples.filter((s) => s.name === METRIC_NAMES.kvCacheHit);
    expect(hitSamples.map((s) => s.value)).toEqual([1, 0]);
  });

  it("records LLM failures tagged by category", () => {
    const samples: Array<{ name: string; value: number; tags?: Record<string, string> }> = [];
    const collector = new MetricsCollector({
      sinks: [(s) => samples.push({ name: s.name, value: s.value, ...(s.tags ? { tags: s.tags } : {}) })],
    });
    const metrics = new AgentMetrics(collector);

    metrics.recordLlmFailure({ sessionId: "sess-1", category: "transport" });
    metrics.recordLlmFailure({ sessionId: "sess-1", category: "grammar" });
    metrics.recordLlmFailure({ sessionId: "sess-1", category: "model" });

    const failures = samples.filter((s) => s.name === METRIC_NAMES.llmFailure);
    expect(failures).toHaveLength(3);
    expect(failures.map((s) => s.tags?.category)).toEqual([
      "transport",
      "grammar",
      "model",
    ]);
    expect(failures.every((s) => s.tags?.sessionId === "sess-1")).toBe(true);
  });

  it("records reflection outcomes tagged by outcome with matching latency samples", () => {
    const samples: Array<{ name: string; value: number; tags?: Record<string, string> }> = [];
    const collector = new MetricsCollector({
      sinks: [
        (s) =>
          samples.push({
            name: s.name,
            value: s.value,
            ...(s.tags ? { tags: s.tags } : {}),
          }),
      ],
    });
    const metrics = new AgentMetrics(collector);

    const outcomes: Array<"ok" | "none" | "aborted" | "timeout" | "failed"> = [
      "ok",
      "none",
      "aborted",
      "timeout",
      "failed",
    ];
    for (const outcome of outcomes) {
      metrics.recordReflection({
        sessionId: "sess-1",
        outcome,
        durationMs: 42,
      });
    }

    const counters = samples.filter(
      (s) => s.name === METRIC_NAMES.memoryReflection,
    );
    expect(counters.map((s) => s.tags?.outcome)).toEqual(outcomes);
    expect(counters.every((s) => s.tags?.sessionId === "sess-1")).toBe(true);

    const latencies = samples.filter(
      (s) => s.name === METRIC_NAMES.memoryReflectionLatency,
    );
    expect(latencies).toHaveLength(outcomes.length);
    expect(latencies.every((s) => s.value === 42)).toBe(true);
    expect(latencies.map((s) => s.tags?.outcome)).toEqual(outcomes);
  });
});

describe("NDJSON sinks", () => {
  it("wraps log records in sidecar log events", () => {
    const events: SidecarEvent[] = [];
    const sink = createLogNdjsonSink((e) => events.push(e));
    sink({ level: "info", message: "hello", context: { k: 1 }, timestamp: 123 });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("log");
    const payload = events[0]?.payload as LogPayload;
    expect(payload.level).toBe("info");
    expect(payload.message).toBe("hello");
    expect(payload.context).toEqual({ k: 1 });
  });

  it("wraps metric samples in sidecar metric events with timestamp", () => {
    const events: SidecarEvent[] = [];
    const sink = createMetricNdjsonSink((e) => events.push(e));
    sink({ name: "agent.step.tokens", value: 1200, tags: { outcome: "ok" }, timestamp: 42 });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("metric");
    const payload = events[0]?.payload as MetricPayload & { timestamp: number };
    expect(payload.name).toBe("agent.step.tokens");
    expect(payload.value).toBe(1200);
    expect(payload.tags).toEqual({ outcome: "ok" });
    expect(payload.timestamp).toBe(42);
  });

  it("end-to-end: logger -> ndjson log event", () => {
    const events: SidecarEvent[] = [];
    const logger = new StructuredLogger({
      level: "debug",
      sinks: [createLogNdjsonSink((e) => events.push(e))],
    });
    logger.warn("disk filling up", { usage: 0.9 });
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as LogPayload;
    expect(payload.level).toBe("warn");
    expect(payload.message).toBe("disk filling up");
    expect(payload.context).toEqual({ usage: 0.9 });
  });
});
