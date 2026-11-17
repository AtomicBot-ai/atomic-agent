import { describe, expect, it } from "vitest";

import { AgentMetrics, METRIC_NAMES } from "./agent-metrics.js";
import { MetricsCollector } from "./metrics-collector.js";
import { formatPrometheus } from "./prometheus-format.js";
import { PrometheusRegistry, prometheusNameFor } from "./prometheus-registry.js";

function rig() {
  const registry = new PrometheusRegistry();
  const metrics = new AgentMetrics(new MetricsCollector({ sinks: [registry.sink] }));
  return { registry, metrics, text: () => formatPrometheus(registry.families()) };
}

describe("PrometheusRegistry (ATO-646)", () => {
  it("names counters with _total and leaves gauges and summaries alone", () => {
    expect(prometheusNameFor(METRIC_NAMES.turnCompleted, "counter")).toBe("atomic_agent_turn_completed_total");
    expect(prometheusNameFor(METRIC_NAMES.turnDuration, "histogram")).toBe("atomic_agent_turn_duration_ms");
    expect(prometheusNameFor(METRIC_NAMES.kvCacheHit, "gauge")).toBe("atomic_agent_llm_kv_cache_hit");
  });

  it("sums counters across sessions instead of keeping one series per chat", () => {
    const { metrics, text } = rig();
    metrics.recordTurn({ sessionId: "s-1", origin: "http", outcome: "reply", durationMs: 100 });
    metrics.recordTurn({ sessionId: "s-2", origin: "http", outcome: "reply", durationMs: 300 });
    metrics.recordTurn({ sessionId: "s-1", origin: "http", outcome: "reply", durationMs: 200 });
    metrics.recordTurn({ sessionId: "s-3", origin: "scheduler", outcome: "failed", durationMs: 50 });

    const out = text();
    expect(out).toContain('atomic_agent_turn_completed_total{origin="http",outcome="reply"} 3');
    expect(out).toContain('atomic_agent_turn_completed_total{origin="scheduler",outcome="failed"} 1');
    expect(out).toContain('atomic_agent_turn_duration_ms_sum{origin="http",outcome="reply"} 600');
    expect(out).toContain('atomic_agent_turn_duration_ms_count{origin="http",outcome="reply"} 3');
    expect(out).toContain("# TYPE atomic_agent_turn_duration_ms summary");
    expect(out).not.toMatch(/session/i);
    expect(out).not.toContain("s-1");
  });

  it("splits provider failures by category and provider link", () => {
    const { metrics, text } = rig();
    metrics.recordLlmFailure({ sessionId: "s-1", category: "transport", provider: "openrouter" });
    metrics.recordLlmFailure({ sessionId: "s-2", category: "transport", provider: "openrouter" });
    metrics.recordLlmFailure({ sessionId: "s-1", category: "model" });

    const out = text();
    expect(out).toContain('atomic_agent_llm_failure_total{category="transport",provider="openrouter"} 2');
    expect(out).toContain('atomic_agent_llm_failure_total{category="model"} 1');
  });

  it("counts tool calls per tool and failures apart", () => {
    const { metrics, text } = rig();
    metrics.recordTool({ sessionId: "s-1", tool: "fs.read", status: "ok", durationMs: 1 });
    metrics.recordTool({ sessionId: "s-2", tool: "fs.read", status: "error", durationMs: 1 });

    const out = text();
    expect(out).toContain('atomic_agent_tool_call_total{tool="fs.read"} 2');
    expect(out).toContain('atomic_agent_tool_success_total{tool="fs.read"} 1');
    expect(out).toContain('atomic_agent_tool_failure_total{tool="fs.read"} 1');
  });

  it("keeps the last gauge reading", () => {
    const { metrics, text } = rig();
    metrics.recordLlmCall({ sessionId: "s-1", promptTokens: 1, completionTokens: 1, durationMs: 5, cacheReused: true });
    metrics.recordLlmCall({ sessionId: "s-1", promptTokens: 1, completionTokens: 1, durationMs: 5, cacheReused: false });
    expect(text()).toContain("atomic_agent_llm_kv_cache_hit 0");
  });

  it("drops tags that are not on the allowlist, ids above all", () => {
    const registry = new PrometheusRegistry();
    registry.observe({
      name: "agent.memory.lessons.created",
      value: 1,
      delta: 1,
      kind: "counter",
      tags: { lessonId: "42", taskId: "t-9", outcome: "ok" },
      timestamp: 0,
    });
    const out = formatPrometheus(registry.families());
    expect(out).toContain('atomic_agent_memory_lessons_created_total{outcome="ok"} 1');
    expect(out).not.toContain("42");
    expect(out).not.toContain("t-9");
  });

  it("ignores samples without a kind and a kind that disagrees with the first", () => {
    const registry = new PrometheusRegistry();
    registry.observe({ name: "agent.x", value: 1, timestamp: 0 });
    registry.observe({ name: "agent.y", value: 2, kind: "gauge", timestamp: 0 });
    registry.observe({ name: "agent.y", value: 9, kind: "histogram", timestamp: 0 });
    const out = formatPrometheus(registry.families());
    expect(out).not.toContain("atomic_agent_x");
    expect(out).toContain("atomic_agent_y 2");
    expect(out).not.toContain("atomic_agent_y_count");
  });

  it("stops adding label sets past the cap and counts what it dropped", () => {
    const registry = new PrometheusRegistry();
    for (let i = 0; i < 205; i += 1) {
      registry.observe({ name: "agent.tool.call", value: 1, delta: 1, kind: "counter", tags: { tool: `t${i}` }, timestamp: 0 });
    }
    const families = registry.families();
    const calls = families.find((f) => f.name === "atomic_agent_tool_call_total");
    expect(calls?.series).toHaveLength(200);
    expect(formatPrometheus(families)).toContain("atomic_metrics_series_dropped_total 5");
  });
});
