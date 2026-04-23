import type { LlmFailureCategory } from "../llm/reliability/index.js";
import type { MetricsCollector } from "./metrics-collector.js";

/**
 * Canonical metric names emitted by the agent loop. Keep this enum in
 * sync with the dashboard/UI consumers so names never drift silently.
 */
export const METRIC_NAMES = {
  stepTokens: "agent.step.tokens",
  stepDuration: "agent.step.duration_ms",
  stepOutcome: "agent.step.outcome",
  kvCacheHit: "agent.llm.kv_cache_hit",
  llmLatency: "agent.llm.latency_ms",
  llmPromptTokens: "agent.llm.prompt_tokens",
  llmCompletionTokens: "agent.llm.completion_tokens",
  llmFailure: "agent.llm.failure",
  toolCall: "agent.tool.call",
  toolSuccess: "agent.tool.success",
  toolFailure: "agent.tool.failure",
  approvalRequested: "agent.approval.requested",
  approvalGranted: "agent.approval.granted",
  approvalDenied: "agent.approval.denied",
  memoryReflection: "agent.memory.reflection",
  memoryReflectionLatency: "agent.memory.reflection.latency_ms",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export interface StepMetricSample {
  sessionId: string;
  stepIndex: number;
  tokensUsed: number;
  durationMs: number;
  outcome: "ok" | "error";
}

export interface LlmMetricSample {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  cacheReused: boolean;
}

export interface ToolMetricSample {
  sessionId: string;
  tool: string;
  status: "ok" | "error";
  durationMs: number;
}

export interface LlmFailureMetricSample {
  sessionId: string;
  category: LlmFailureCategory;
}

/**
 * Canonical outcome taxonomy for the async reflection runner. Kept here
 * next to the other metric samples so dashboards can enumerate the full
 * tag space from a single module.
 */
export type ReflectionOutcomeTag =
  | "ok"
  | "none"
  | "aborted"
  | "timeout"
  | "failed";

export interface ReflectionMetricSample {
  sessionId: string;
  outcome: ReflectionOutcomeTag;
  durationMs: number;
}

/**
 * Thin, opinionated wrapper over MetricsCollector that emits the
 * canonical agent metrics. Callers never call counter/gauge directly —
 * that keeps names and tag shapes consistent across the codebase.
 */
export class AgentMetrics {
  constructor(private readonly collector: MetricsCollector) {}

  recordStep(sample: StepMetricSample): void {
    const tags = { sessionId: sample.sessionId, outcome: sample.outcome };
    this.collector.histogram(METRIC_NAMES.stepTokens, sample.tokensUsed, tags);
    this.collector.histogram(METRIC_NAMES.stepDuration, sample.durationMs, tags);
    this.collector.counter(METRIC_NAMES.stepOutcome, 1, tags);
  }

  recordLlmCall(sample: LlmMetricSample): void {
    const tags = {
      sessionId: sample.sessionId,
      cacheReused: sample.cacheReused ? "true" : "false",
    };
    this.collector.histogram(METRIC_NAMES.llmLatency, sample.durationMs, tags);
    this.collector.histogram(METRIC_NAMES.llmPromptTokens, sample.promptTokens, tags);
    this.collector.histogram(
      METRIC_NAMES.llmCompletionTokens,
      sample.completionTokens,
      tags,
    );
    this.collector.gauge(
      METRIC_NAMES.kvCacheHit,
      sample.cacheReused ? 1 : 0,
      { sessionId: sample.sessionId },
    );
  }

  recordTool(sample: ToolMetricSample): void {
    const tags = { sessionId: sample.sessionId, tool: sample.tool };
    this.collector.counter(METRIC_NAMES.toolCall, 1, tags);
    if (sample.status === "ok") {
      this.collector.counter(METRIC_NAMES.toolSuccess, 1, tags);
    } else {
      this.collector.counter(METRIC_NAMES.toolFailure, 1, tags);
    }
  }

  /**
   * Record a terminal failure on an agent turn, tagged by the canonical
   * LLM failure category (`transport` / `grammar` / `model` / `tool` /
   * `cancelled`). Dashboards aggregate this counter per session to spot
   * degraded llama-server backends, grammar regressions, or sustained
   * model-side defects.
   */
  recordLlmFailure(sample: LlmFailureMetricSample): void {
    this.collector.counter(METRIC_NAMES.llmFailure, 1, {
      sessionId: sample.sessionId,
      category: sample.category,
    });
  }

  /**
   * Record the outcome of a single async end-of-turn reflection call.
   * The counter is tagged by `outcome` so dashboards can surface the
   * `failed` / `timeout` ratio at a glance; the latency histogram is
   * tagged identically so slow `ok` calls stay distinguishable from
   * slow `timeout`s.
   */
  recordReflection(sample: ReflectionMetricSample): void {
    const tags = { sessionId: sample.sessionId, outcome: sample.outcome };
    this.collector.counter(METRIC_NAMES.memoryReflection, 1, tags);
    this.collector.histogram(
      METRIC_NAMES.memoryReflectionLatency,
      sample.durationMs,
      tags,
    );
  }

  recordApproval(input: { sessionId: string; tool: string; approved: boolean }): void {
    const tags = { sessionId: input.sessionId, tool: input.tool };
    this.collector.counter(METRIC_NAMES.approvalRequested, 1, tags);
    if (input.approved) {
      this.collector.counter(METRIC_NAMES.approvalGranted, 1, tags);
    } else {
      this.collector.counter(METRIC_NAMES.approvalDenied, 1, tags);
    }
  }
}
