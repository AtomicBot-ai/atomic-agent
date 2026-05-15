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
  tasksScheduled: "agent.tasks.scheduled",
  tasksRecurringRequeued: "agent.tasks.recurring_requeued",
  tasksSessionRecreated: "agent.tasks.session_recreated",
  tasksSessionAutoCreated: "agent.tasks.session_auto_created",
  schedulerTicks: "agent.scheduler.ticks",
  schedulerTickErrors: "agent.scheduler.tick_errors",
  schedulerBatchSize: "agent.scheduler.batch_size",
  schedulerTickDuration: "agent.scheduler.tick_duration_ms",
  webhooksReceived: "agent.webhooks.received",
  telegramUp: "agent.telegram.up",
  telegramDown: "agent.telegram.down",
  telegramMessagesReceived: "agent.telegram.messages_received",
  telegramMessagesSent: "agent.telegram.messages_sent",
  telegramApprovalsResolved: "agent.telegram.approvals_resolved",
  batchTrimmed: "agent.batch.trimmed",
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
 * Sample recorded each time the step executor auto-splits a multi-call
 * batch that failed validation. The counter is tagged by `reason` so
 * dashboards can distinguish the (currently sole) approval-gated split
 * from future split causes.
 */
export interface BatchTrimmedMetricSample {
  sessionId: string;
  /** Trim cause; matches the event payload of the same name. */
  reason: "approval-gated-batched";
  /** Original batch size the model emitted. Always >= 2. */
  originalSize: number;
  /** Number of calls dropped (== originalSize - 1). */
  droppedCount: number;
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
export type TaskOriginTag =
  | "cli"
  | "tui"
  | "http"
  | "sidecar"
  | "scheduler"
  | "agent";

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

export interface TaskScheduledSample {
  taskId: string;
  kind: "at" | "cron" | "interval";
  scheduledFor: number;
  recurring: boolean;
}

export interface TaskRecurringRequeuedSample {
  taskId: string;
  sessionId: string;
  nextScheduledFor: number;
}

export interface TaskSessionRecreatedSample {
  taskId: string;
  previousSessionId: string;
  newSessionId: string;
}

export interface TaskSessionAutoCreatedSample {
  sessionId: string;
  reason: "one_shot_lazy" | "recurring_create" | "webhook_persistent";
}

export interface SchedulerTickSample {
  batchSize: number;
  durationMs: number;
  outcome: "ok" | "error";
}

export interface WebhookReceivedSample {
  webhookName: string;
  status: "accepted" | "rejected";
}

/**
 * Telegram remote-control channel events. Counters are intentionally
 * narrow: `up`/`down` mark lifecycle transitions (not poll ticks),
 * `messages_received`/`messages_sent` count agent-visible payloads
 * (slash commands and dropped non-owner DMs are excluded), and
 * `approvals_resolved` fires once per approval decision regardless of
 * whether the resolver was a button tap, the auto-deny timer, or an
 * external `/cancel` propagating into the bridge.
 */
export type TelegramLifecycleOutcome = "ok" | "error";

export interface TelegramLifecycleSample {
  outcome: TelegramLifecycleOutcome;
  /** Last-error category when `outcome === "error"`; opaque short string. */
  reason?: string;
}

export interface TelegramMessageSample {
  /** Direction of the payload from the runtime's POV. */
  direction: "in" | "out";
}

export interface TelegramApprovalSample {
  /** Resolution path so dashboards can split user vs auto-deny vs external. */
  resolver: "button" | "timeout" | "external";
  approved: boolean;
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
   * Record an auto-split of a multi-call batch by `executeStepInner`.
   * Tagged by `reason` (today only `approval-gated-batched`) and
   * `originalSize` so dashboards can distinguish a single dropped call
   * from a wholesale 6-call rejection. `droppedCount` ships as a
   * histogram value so percentile analyses are cheap.
   */
  recordBatchTrimmed(sample: BatchTrimmedMetricSample): void {
    this.collector.counter(METRIC_NAMES.batchTrimmed, 1, {
      sessionId: sample.sessionId,
      reason: sample.reason,
      originalSize: String(sample.originalSize),
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

  /**
   * Record a task being persisted with a non-trivial schedule. Fires
   * exactly once per `TaskStore.create` when `schedule` is set, so
   * dashboards can distinguish eager one-shot tasks from deferred /
   * recurring work without scanning every row.
   */
  recordTaskScheduled(sample: TaskScheduledSample): void {
    this.collector.counter(METRIC_NAMES.tasksScheduled, 1, {
      taskId: sample.taskId,
      kind: sample.kind,
      recurring: sample.recurring ? "true" : "false",
    });
  }

  /**
   * Record a recurring task being requeued after a completed firing.
   * The counter increments exactly once per requeue — not once per
   * firing — so "ticks consumed" vs "tasks requeued" can both be
   * monitored from the scheduler and runner sides.
   */
  recordTaskRecurringRequeued(sample: TaskRecurringRequeuedSample): void {
    this.collector.counter(METRIC_NAMES.tasksRecurringRequeued, 1, {
      taskId: sample.taskId,
      sessionId: sample.sessionId,
    });
  }

  /**
   * Record a recurring task whose persistent session was missing and
   * had to be auto-recreated. Emitted at warn-level by the logger as
   * well; the counter exists for alerting on unexpected session churn.
   */
  recordTaskSessionRecreated(sample: TaskSessionRecreatedSample): void {
    this.collector.counter(METRIC_NAMES.tasksSessionRecreated, 1, {
      taskId: sample.taskId,
      previousSessionId: sample.previousSessionId,
      newSessionId: sample.newSessionId,
    });
  }

  /**
   * Record a session auto-created by the runner — lazy for one-shot
   * tasks, eager for recurring tasks at `create()` time, or persistent
   * for webhooks configured as such.
   */
  recordTaskSessionAutoCreated(sample: TaskSessionAutoCreatedSample): void {
    this.collector.counter(METRIC_NAMES.tasksSessionAutoCreated, 1, {
      sessionId: sample.sessionId,
      reason: sample.reason,
    });
  }

  /**
   * Record one scheduler tick. Tagged by `outcome` so dashboards can
   * spot failing ticks at a glance; the histogram carries the batch
   * size and wall-clock duration for the same tick.
   */
  recordSchedulerTick(sample: SchedulerTickSample): void {
    const tags = { outcome: sample.outcome };
    this.collector.counter(METRIC_NAMES.schedulerTicks, 1, tags);
    if (sample.outcome === "error") {
      this.collector.counter(METRIC_NAMES.schedulerTickErrors, 1, tags);
    }
    this.collector.histogram(
      METRIC_NAMES.schedulerBatchSize,
      sample.batchSize,
      tags,
    );
    this.collector.histogram(
      METRIC_NAMES.schedulerTickDuration,
      sample.durationMs,
      tags,
    );
  }

  /**
   * Record an inbound webhook hit. Tagged by `webhook_name` so each
   * configured webhook can be alerted on independently; `status`
   * distinguishes accepted (task materialised) from rejected (auth,
   * disabled, template, etc.) requests.
   */
  recordWebhookReceived(sample: WebhookReceivedSample): void {
    this.collector.counter(METRIC_NAMES.webhooksReceived, 1, {
      webhook_name: sample.webhookName,
      status: sample.status,
    });
  }

  /**
   * Record a Telegram channel transition into `up`. Bumped only on
   * the actual transition (idempotent `start()` calls do not
   * double-count).
   */
  recordTelegramUp(): void {
    this.collector.counter(METRIC_NAMES.telegramUp, 1, {});
  }

  /**
   * Record a Telegram channel transition into `down`. Bumped on
   * every `disabled→down` / `up→down` transition; the `reason` tag
   * carries an opaque short string (`getMe_failed`, `lock_held`,
   * `missing_token`, …) so dashboards can split persistent backend
   * issues from operator-initiated stops.
   */
  recordTelegramDown(sample: TelegramLifecycleSample = { outcome: "ok" }): void {
    this.collector.counter(METRIC_NAMES.telegramDown, 1, {
      outcome: sample.outcome,
      ...(sample.reason ? { reason: sample.reason } : {}),
    });
  }

  /**
   * Record a Telegram message crossing the agent boundary: an
   * inbound DM dispatched into `runTurn` (`direction: "in"`) or an
   * outbound `assistant_reply` chunk written to the bot
   * (`direction: "out"`). Slash commands handled inside the channel
   * and non-owner DMs dropped before dispatch are intentionally
   * excluded — they are not agent-visible work.
   */
  recordTelegramMessage(sample: TelegramMessageSample): void {
    const counter =
      sample.direction === "in"
        ? METRIC_NAMES.telegramMessagesReceived
        : METRIC_NAMES.telegramMessagesSent;
    this.collector.counter(counter, 1, { direction: sample.direction });
  }

  /**
   * Record an approval decision routed through the Telegram bridge.
   * `resolver` distinguishes button taps, the 8-minute auto-deny
   * timer, and external resolutions that propagate through the
   * router (e.g. operator typed `y`/`n` in the host TUI before the
   * Telegram message was tapped).
   */
  recordTelegramApprovalResolved(sample: TelegramApprovalSample): void {
    this.collector.counter(METRIC_NAMES.telegramApprovalsResolved, 1, {
      resolver: sample.resolver,
      approved: sample.approved ? "true" : "false",
    });
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
