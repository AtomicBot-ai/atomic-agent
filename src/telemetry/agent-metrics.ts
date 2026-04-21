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
  toolCall: "agent.tool.call",
  toolSuccess: "agent.tool.success",
  toolFailure: "agent.tool.failure",
  approvalRequested: "agent.approval.requested",
  approvalGranted: "agent.approval.granted",
  approvalDenied: "agent.approval.denied",
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
