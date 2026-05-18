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
  // memory-v2 phase 1A
  memoryDedupMerged: "agent.memory.dedup.merged",
  memoryDedupSkipped: "agent.memory.dedup.skipped",
  memoryEvictionEvicted: "agent.memory.eviction.evicted",
  memoryClockSkewDetected: "agent.memory.clock_skew_detected",
  // memory-v2 phase 1B
  memoryEmbeddingsGenerated: "agent.memory.embeddings.generated",
  memoryEmbeddingsFallback: "agent.memory.embeddings.fallback_to_fts5",
  memoryEmbeddingsBruteForceOverflow:
    "agent.memory.embeddings.brute_force_overflow",
  memoryEmbeddingsDaemonHealth: "agent.memory.embeddings.daemon_health",
  // memory-v2 phase 2
  memoryLinkGenerator: "agent.memory.link_generator",
  memoryLinkGeneratorDuration: "agent.memory.link_generator.duration_ms",
  memoryLinksWritten: "agent.memory.links_written",
  memoryLinkExpansionHits: "agent.memory.link_expansion.hits",
  // memory-v2 phase 3
  memoryEvolutionApplied: "agent.memory.evolution.applied",
  memoryEvolutionSkipped: "agent.memory.evolution.skipped",
  // memory-v2 phase 4
  memoryProfileSuperseded: "agent.memory.profile.superseded",
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
 * Outcome taxonomy for pre-insert deduplication in `MemoryStore.store`
 * (memory-v2 phase 1A). `merged` means an existing row absorbed the
 * write (touched `updated_at`, bumped `recall_count`); `skipped` means
 * dedup was considered but the candidate did not clear the similarity
 * threshold or tag-superset rule, and the write proceeded as an INSERT.
 * `disabled` is emitted when dedup is feature-flagged off — kept as a
 * tag value so dashboards can distinguish "no dedup attempted" from
 * "dedup attempted, no merge".
 */
export type MemoryDedupOutcomeTag = "merged" | "skipped" | "disabled";

export interface MemoryDedupMetricSample {
  outcome: MemoryDedupOutcomeTag;
  /** Best Jaccard score observed when `outcome ∈ {merged, skipped}`. */
  bestScore: number;
  /** Existing row id for `merged`; for `skipped` the would-be neighbour. */
  candidateId: number | null;
}

export interface MemoryEvictionMetricSample {
  /**
   * Path that triggered the delete. `overflow` is the per-write check
   * (count > maxEntries); future phases add `age` (consolidator sweep).
   */
  reason: "overflow" | "age";
  /** Row count removed in this single SQL statement. */
  evicted: number;
  /** Whether utility-weighted ordering was applied (false ⇒ legacy FIFO). */
  utilityWeighted: boolean;
}

/**
 * Tag space for clock-skew detection. Emitted whenever a temporal
 * subtraction `(now - ts)` produces a negative value — cross-phase
 * invariant 7 (§13.7.2 of the v2 plan). `site` identifies the caller
 * so dashboards can isolate "is it dedup, eviction, or recall scoring".
 */
export type MemoryClockSkewSiteTag =
  | "memory_store_recall"
  | "memory_store_dedup"
  | "memory_store_eviction";

export interface MemoryClockSkewMetricSample {
  site: MemoryClockSkewSiteTag;
  /** `now - ts` value that triggered the detection (negative). */
  deltaMs: number;
}

/**
 * Memory-v2 phase 1B embedding-side samples. Kept narrow:
 *   - `Generated` fires once per successful embedding write.
 *   - `Fallback` fires once per recall that degraded to FTS5-only.
 *   - `BruteForceOverflow` fires once per recall that skipped cosine
 *     because the corpus is past the soft ceiling.
 *   - `DaemonHealth` is bootstrap-only and snapshots whether the
 *     second daemon is reachable.
 */
export interface MemoryEmbeddingsGeneratedSample {
  model: string;
  durationMs: number;
}

export type MemoryEmbeddingsFallbackReason =
  | "embed_failed"
  | "client_missing"
  | "store_missing"
  | "feature_disabled";

export interface MemoryEmbeddingsFallbackSample {
  reason: MemoryEmbeddingsFallbackReason;
}

export interface MemoryEmbeddingsBruteForceOverflowSample {
  rows: number;
  ceiling: number;
}

export interface MemoryEmbeddingsDaemonHealthSample {
  outcome: "ok" | "unreachable" | "disabled";
  model: string | null;
}

/**
 * Memory-v2 phase 2. Link-generator + expansion samples.
 *
 *   - `LinkGenerator` is the outcome of one `link-generator` sub-call
 *     (mirrors the reflection taxonomy: ok / none / aborted / timeout /
 *     failed, plus `skipped` for "too few candidates to bother").
 *   - `LinksWritten` is incremented once per persisted edge — useful
 *     for plotting graph growth rate over time.
 *   - `LinkExpansionHits` fires per recall turn that surfaced one or
 *     more BFS-expanded ids, tagged by the resulting expansion count
 *     bucket so dashboards can spot pathological depths.
 */
export type LinkGeneratorOutcomeTag =
  | "ok"
  | "none"
  | "skipped"
  | "aborted"
  | "timeout"
  | "failed";

export interface MemoryLinkGeneratorSample {
  sessionId: string;
  outcome: LinkGeneratorOutcomeTag;
  durationMs: number;
  linksWritten?: number;
}

export interface MemoryLinksWrittenSample {
  source: "link_generator" | "tool" | "reflection";
  kind: string;
}

export interface MemoryLinkExpansionHitsSample {
  /** Number of unique ids the BFS expanded into (excluding seeds). */
  expanded: number;
  depth: number;
}

/**
 * Memory-v2 phase 3. Per-EVOLVE-directive outcome.
 *
 *  - `applied`                  — the row's tags actually grew.
 *  - `skipped_lease_held`       — `consolidating_at` lease was fresh.
 *  - `skipped_no_change`        — every proposed tag was already present.
 *  - `skipped_not_in_allowlist` — target id not in the per-turn surfaced set.
 *  - `skipped_cap_hit`          — `maxPerWrite` budget exhausted.
 *  - `skipped_missing`          — target id no longer exists.
 *  - `skipped_invalid`          — `MemoryValidationError` from the store
 *                                 (empty tag list, oversized tag, …).
 */
export type MemoryEvolutionOutcomeTag =
  | "applied"
  | "skipped_lease_held"
  | "skipped_no_change"
  | "skipped_not_in_allowlist"
  | "skipped_cap_hit"
  | "skipped_missing"
  | "skipped_invalid";

export interface MemoryEvolutionSample {
  sessionId: string;
  outcome: MemoryEvolutionOutcomeTag;
}

/**
 * Memory-v2 phase 4. A bi-temporal profile write that superseded an
 * existing active row. The previous active row's `superseded_by`
 * was flipped to the new row's id inside the same transaction.
 *
 * `key` is the profile key being versioned; `previousId` and
 * `nextId` are the row ids on either side of the chain. Useful for
 * postmortem of "did the LLM rewrite something I cared about" via
 * `memory.profile.history`.
 */
export interface MemoryProfileSupersededSample {
  key: string;
  previousId: number;
  nextId: number;
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
   * Record a pre-insert dedup decision in `MemoryStore.store`. Two
   * separate counters so dashboards can compute merge ratio without
   * scanning histograms. Emitted exactly once per write attempt.
   */
  recordMemoryDedup(sample: MemoryDedupMetricSample): void {
    const tags = {
      outcome: sample.outcome,
      bestScore: sample.bestScore.toFixed(3),
      ...(sample.candidateId !== null
        ? { candidateId: String(sample.candidateId) }
        : {}),
    };
    if (sample.outcome === "merged") {
      this.collector.counter(METRIC_NAMES.memoryDedupMerged, 1, tags);
    } else {
      this.collector.counter(METRIC_NAMES.memoryDedupSkipped, 1, tags);
    }
  }

  /**
   * Record an overflow-eviction sweep. Counter bumped by `evicted`
   * (the actual row count removed), not 1 — so the metric reflects
   * deleted volume rather than tick count.
   */
  recordMemoryEviction(sample: MemoryEvictionMetricSample): void {
    if (sample.evicted <= 0) return;
    this.collector.counter(
      METRIC_NAMES.memoryEvictionEvicted,
      sample.evicted,
      {
        reason: sample.reason,
        utilityWeighted: sample.utilityWeighted ? "true" : "false",
      },
    );
  }

  /**
   * Record a clock-skew detection. Fire-and-forget signal: the caller
   * has already clamped to the safe end and proceeded; this counter
   * exists so persistent DB-clock drift is visible in dashboards.
   */
  recordMemoryClockSkew(sample: MemoryClockSkewMetricSample): void {
    this.collector.counter(METRIC_NAMES.memoryClockSkewDetected, 1, {
      site: sample.site,
      deltaMs: String(sample.deltaMs),
    });
  }

  /**
   * Memory-v2 phase 1B. Record a successful embedding generation +
   * persistence. `durationMs` includes both the HTTP round-trip and
   * the `EmbeddingStore.upsert` call so the histogram surfaces the
   * full write path latency.
   */
  recordMemoryEmbeddingsGenerated(
    sample: MemoryEmbeddingsGeneratedSample,
  ): void {
    this.collector.counter(METRIC_NAMES.memoryEmbeddingsGenerated, 1, {
      model: sample.model,
    });
  }

  /**
   * Memory-v2 phase 1B. Record a hybrid recall that degraded to
   * FTS5-only. Tagged by reason so dashboards can distinguish a
   * transient daemon outage (`embed_failed`) from a permanent
   * deployment state (`feature_disabled`).
   */
  recordMemoryEmbeddingsFallback(
    sample: MemoryEmbeddingsFallbackSample,
  ): void {
    this.collector.counter(METRIC_NAMES.memoryEmbeddingsFallback, 1, {
      reason: sample.reason,
    });
  }

  /**
   * Memory-v2 phase 1B. Soft warning: corpus has outgrown the
   * brute-force cosine path. Cosine is skipped; FTS5 still serves.
   * Persistent emission of this metric is the signal to wire
   * `sqlite-vec` or trim the corpus.
   */
  recordMemoryEmbeddingsBruteForceOverflow(
    sample: MemoryEmbeddingsBruteForceOverflowSample,
  ): void {
    this.collector.counter(
      METRIC_NAMES.memoryEmbeddingsBruteForceOverflow,
      1,
      {
        rows: String(sample.rows),
        ceiling: String(sample.ceiling),
      },
    );
  }

  /**
   * Memory-v2 phase 1B. Snapshot the embedding daemon's reachability
   * at bootstrap. One sample per runtime start; the `disabled` outcome
   * is emitted when the feature flag is off so dashboards can
   * distinguish "nobody asked for embeddings" from "embeddings asked
   * but daemon down".
   */
  recordMemoryEmbeddingsDaemonHealth(
    sample: MemoryEmbeddingsDaemonHealthSample,
  ): void {
    this.collector.counter(METRIC_NAMES.memoryEmbeddingsDaemonHealth, 1, {
      outcome: sample.outcome,
      ...(sample.model ? { model: sample.model } : {}),
    });
  }

  /**
   * Memory-v2 phase 2. Record a `link-generator` sub-call outcome.
   * The histogram pairs with the counter so dashboards can compute
   * both error rate and p95 latency from one set of samples.
   */
  recordLinkGenerator(sample: MemoryLinkGeneratorSample): void {
    const tags: Record<string, string> = {
      session_id: sample.sessionId,
      outcome: sample.outcome,
    };
    this.collector.counter(METRIC_NAMES.memoryLinkGenerator, 1, tags);
    this.collector.histogram(
      METRIC_NAMES.memoryLinkGeneratorDuration,
      sample.durationMs,
      tags,
    );
    if (typeof sample.linksWritten === "number") {
      this.collector.counter(
        METRIC_NAMES.memoryLinksWritten,
        sample.linksWritten,
        {
          source: "link_generator",
          kind: "any",
        },
      );
    }
  }

  /**
   * Memory-v2 phase 3. Record one EVOLVE-directive outcome. Successful
   * evolutions land on `agent.memory.evolution.applied`; every
   * `skipped_*` flavour lands on `agent.memory.evolution.skipped`
   * tagged by `reason` (the suffix after `skipped_`). The dual-
   * counter shape matches the scorecard's §3.A.4 / §3.B.2 asserts.
   */
  recordMemoryEvolution(sample: MemoryEvolutionSample): void {
    const tags: Record<string, string> = { session_id: sample.sessionId };
    if (sample.outcome === "applied") {
      this.collector.counter(METRIC_NAMES.memoryEvolutionApplied, 1, tags);
      return;
    }
    this.collector.counter(METRIC_NAMES.memoryEvolutionSkipped, 1, {
      ...tags,
      reason: sample.outcome.replace(/^skipped_/, ""),
    });
  }

  /**
   * Memory-v2 phase 4. Record a bi-temporal profile supersession.
   * One increment per row flipped — a cross-key supersession that
   * touches two parents fires this twice with distinct `previousId`s.
   */
  recordProfileSuperseded(sample: MemoryProfileSupersededSample): void {
    this.collector.counter(METRIC_NAMES.memoryProfileSuperseded, 1, {
      key: sample.key,
      previous_id: String(sample.previousId),
      next_id: String(sample.nextId),
    });
  }

  /**
   * Memory-v2 phase 2. Record a recall turn that surfaced one or more
   * link-expanded ids alongside the BM25/cosine hits.
   */
  recordMemoryLinkExpansion(sample: MemoryLinkExpansionHitsSample): void {
    this.collector.counter(METRIC_NAMES.memoryLinkExpansionHits, 1, {
      expanded: String(sample.expanded),
      depth: String(sample.depth),
    });
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
