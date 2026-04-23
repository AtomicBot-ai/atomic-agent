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
  tasksCreated: "agent.tasks.created",
  tasksStarted: "agent.tasks.started",
  tasksCompleted: "agent.tasks.completed",
  tasksFailed: "agent.tasks.failed",
  tasksBlocked: "agent.tasks.blocked",
  tasksCancelled: "agent.tasks.cancelled",
  tasksRetried: "agent.tasks.retried",
  tasksAttempts: "agent.tasks.attempts",
  tasksDuration: "agent.tasks.duration_ms",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

const TASK_STATUS_COUNTER = {
  completed: METRIC_NAMES.tasksCompleted,
  failed: METRIC_NAMES.tasksFailed,
  blocked: METRIC_NAMES.tasksBlocked,
  cancelled: METRIC_NAMES.tasksCancelled,
} as const;

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
 * Terminal task statuses tracked by the durable task queue. Mirrors
 * `TaskStatus` from `src/tasks/` minus the in-flight states (`pending`
 * / `running`) which never reach the metrics layer.
 */
export type TaskTerminalStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/** Origin tag used by every task-level metric for downstream slicing. */
export type TaskOriginTag = "cli" | "tui" | "http" | "sidecar" | "scheduler";

export interface TaskCreatedSample {
  taskId: string;
  sessionId: string;
  origin: TaskOriginTag;
}

export interface TaskStartedSample {
  taskId: string;
  sessionId: string;
  origin: TaskOriginTag;
  /** 1-indexed attempt about to run (post-`markRunning` value). */
  attempt: number;
}

export interface TaskRetrySample {
  taskId: string;
  sessionId: string;
  category: LlmFailureCategory;
  attempt: number;
}

export interface TaskTerminalSample {
  taskId: string;
  sessionId: string;
  origin: TaskOriginTag;
  status: TaskTerminalStatus;
  attempts: number;
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

  /**
   * Record a fresh durable task being persisted by `TaskStore.create`.
   * Tagged by `origin` so dashboards can split CLI-driven tasks from
   * the future scheduler. The counter is bumped exactly once per row,
   * regardless of how many attempts the task ends up consuming.
   */
  recordTaskCreated(sample: TaskCreatedSample): void {
    this.collector.counter(METRIC_NAMES.tasksCreated, 1, {
      sessionId: sample.sessionId,
      origin: sample.origin,
    });
  }

  /**
   * Record an attempt about to enter `runTurn`. Bumps once per
   * `markRunning`, which means retried tasks emit the counter multiple
   * times with growing `attempt`.
   */
  recordTaskStarted(sample: TaskStartedSample): void {
    this.collector.counter(METRIC_NAMES.tasksStarted, 1, {
      sessionId: sample.sessionId,
      origin: sample.origin,
      attempt: String(sample.attempt),
    });
  }

  /**
   * Record a retryable failure that scheduled a new attempt (no
   * terminal status yet). Distinct from `recordTaskTerminal` — a task
   * may emit several `retried` samples before resolving to one
   * `completed` / `failed`.
   */
  recordTaskRetry(sample: TaskRetrySample): void {
    this.collector.counter(METRIC_NAMES.tasksRetried, 1, {
      sessionId: sample.sessionId,
      category: sample.category,
      attempt: String(sample.attempt),
    });
  }

  /**
   * Record a terminal task transition. Emits the per-status counter,
   * the attempt-count histogram, and the wall-clock duration histogram
   * in one place so dashboards never need to stitch them together.
   */
  recordTaskTerminal(sample: TaskTerminalSample): void {
    const tags = {
      sessionId: sample.sessionId,
      origin: sample.origin,
      status: sample.status,
    };
    const counterName = TASK_STATUS_COUNTER[sample.status];
    this.collector.counter(counterName, 1, tags);
    this.collector.histogram(METRIC_NAMES.tasksAttempts, sample.attempts, tags);
    this.collector.histogram(
      METRIC_NAMES.tasksDuration,
      Math.max(0, sample.durationMs),
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
