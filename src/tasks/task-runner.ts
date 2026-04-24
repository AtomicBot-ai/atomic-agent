import { classifyFailure } from "../llm/reliability/index.js";
import type { LlmFailureCategory } from "../llm/reliability/index.js";
import type { RunTurnResult } from "../agent/agent-loop.js";
import type { SessionState } from "../session/index.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { TurnEventHook, TurnOrigin } from "../runtime/turn-controller.js";

import { nextDelayMs, type BackoffOptions } from "./task-backoff.js";
import { isRecurring, resolveScheduledFor } from "./task-schedule.js";
import type {
  TaskRecord,
  TaskSchedule,
  TaskStatus,
  TriggerSource,
} from "./task-types.js";
import type { TaskCreateInput, TaskStore } from "./task-store.js";

/**
 * Subset of `AgentRuntime` consumed by the task runner. Declared
 * structurally so tests can pass a minimal fake without standing up the
 * full runtime — the runner never touches the loop, tools, or memory
 * fabric directly.
 */
export interface TaskRunnerRuntime {
  runTurn(
    session: SessionState,
    userMessage: string,
    options?: {
      maxSteps?: number;
      signal?: AbortSignal;
      origin?: TurnOrigin;
      eventHook?: TurnEventHook;
    },
  ): Promise<RunTurnResult>;
}

export interface TaskRunnerSessionLoader {
  load(sessionId: string): SessionState | null;
}

/**
 * Narrow surface used by the runner to stamp wake-reason metadata on
 * a session before `runTurn` and to create ephemeral / recurring
 * sessions on demand. Kept as its own type so tests can mock it with a
 * minimal fake.
 */
export interface TaskRunnerSessionFactory {
  /**
   * Create and persist a brand-new session with optional metadata.
   * Used for (a) lazy one-shot task sessions, (b) persistent recurring
   * task sessions at `create()` time, (c) auto-recreation when a
   * recurring task's session is gone.
   */
  create(input?: { metadata?: Record<string, unknown> }): SessionState;
  /**
   * Persist an already-loaded session. Used to stamp
   * `metadata.wakeReason` before `runTurn` picks the session up.
   */
  save(state: SessionState): void;
}

export interface TaskRunnerOptions {
  store: TaskStore;
  runtime: TaskRunnerRuntime;
  sessionLoader: TaskRunnerSessionLoader;
  /**
   * Session factory used for lazy session creation on one-shot tasks
   * and auto-recreation on recurring tasks. Optional for backwards
   * compatibility with tests that only exercise the pre-scheduler
   * code paths; production wiring always supplies one.
   */
  sessionFactory?: TaskRunnerSessionFactory;
  /**
   * Default `agent.maxSteps` applied when a task does not pin its own
   * value. Resolved from the runtime config at bootstrap.
   */
  defaultMaxSteps: number;
  backoff: BackoffOptions;
  /** When `false`, `drainPending` is a no-op (mirrors `tasks.enabled=false`). */
  enabled: boolean;
  /**
   * When `true`, `create()` schedules an immediate `drainPending`
   * scoped to the new task's session. The drain runs detached
   * (fire-and-forget) so the create surface returns the persisted row
   * without blocking on `runTurn`. The runner reports drain failures
   * via `logger`; callers that need to await the drain should call
   * `drainPending` directly instead.
   *
   * Scheduled tasks (`scheduled_for > now`) are never eager-drained
   * regardless of this flag — they are left for the scheduler.
   */
  runOnCreate: boolean;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /**
   * Test seam for the inter-attempt sleep. Production uses the real
   * `setTimeout`; tests substitute a fake to keep the suite fast.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface DrainOptions {
  sessionId?: string;
  /** Hard upper bound on the number of pending tasks consumed in this drain. */
  limit?: number;
  /**
   * Optional cancellation. When fired the drain stops at the next
   * task boundary; the in-flight task continues until `runTurn`
   * itself observes the signal.
   */
  signal?: AbortSignal;
}

export interface DrainOutcome {
  drained: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  retried: number;
}

/**
 * Drives the durable task queue. Three surfaces:
 *
 *  - `runOne(taskId)` — atomically claim and execute a single attempt.
 *    Decides between `completed` / `failed` / `blocked` / `cancelled` /
 *    re-queued-`pending` based on the canonical `LlmFailureCategory`.
 *    Handles lazy session creation, recurring session auto-recreation,
 *    and recurring requeue on completion.
 *
 *  - `drainPending(opts)` — pull all pending tasks (optionally filtered
 *    by `sessionId`), group by session, and drain each group
 *    sequentially while different sessions run in parallel. Per-session
 *    FIFO is enforced both here and downstream by `TurnController`;
 *    cross-session parallelism is inherited verbatim from
 *    `TurnController`.
 *
 *  - `runDue(now, limit)` — scheduler-facing drain over `listDue`.
 *    Identical per-session FIFO / cross-session parallel structure as
 *    `drainPending`, but keyed off the `scheduled_for` index so the
 *    ticker never does a full-table scan.
 *
 * The only new periodic timer in the runtime lives in the `Scheduler`
 * class — this runner is still purely event-driven.
 */
export class TaskRunner {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TaskRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Persist a new task and (when `runOnCreate=true` and the task is
   * not future-scheduled) schedule an immediate drain for its session.
   * The drain is detached — callers never await `runTurn` from inside
   * `create`. Returns the freshly persisted row.
   *
   * Session resolution rules:
   *  - `input.sessionId` provided -> used verbatim.
   *  - else if recurring schedule -> a fresh persistent session is
   *    created now and attached to the row (reused across every firing).
   *  - else (one-shot) -> `session_id = NULL`; `runOne` creates one
   *    lazily at the first execution.
   */
  create(input: TaskCreateInput, now: number = Date.now()): TaskRecord {
    const schedule = input.schedule ?? null;
    const scheduledFor =
      schedule && input.scheduledFor === undefined
        ? resolveScheduledFor(schedule, now)
        : (input.scheduledFor ?? null);

    let sessionId: string | null | undefined = input.sessionId ?? null;
    if (sessionId === null && isRecurring(schedule) && this.options.sessionFactory) {
      const label = schedule && schedule.kind === "cron" ? "cron" : "interval";
      const fresh = this.options.sessionFactory.create({
        metadata: {
          recurringTask: true,
          scheduleKind: label,
        },
      });
      sessionId = fresh.id;
      this.options.metrics?.recordTaskSessionAutoCreated({
        sessionId: fresh.id,
        reason: "recurring_create",
      });
    }

    const record = this.options.store.create(
      {
        ...input,
        sessionId,
        schedule,
        scheduledFor,
      },
      now,
    );
    this.options.metrics?.recordTaskCreated({
      taskId: record.id,
      sessionId: record.sessionId ?? "<unassigned>",
      origin: record.origin,
    });
    if (schedule) {
      this.options.metrics?.recordTaskScheduled({
        taskId: record.id,
        kind: schedule.kind,
        scheduledFor: record.scheduledFor ?? 0,
        recurring: record.recurring,
      });
    }

    const shouldEagerDrain =
      this.options.enabled &&
      this.options.runOnCreate &&
      (record.scheduledFor === null || record.scheduledFor <= now) &&
      record.sessionId !== null;
    if (shouldEagerDrain) {
      const drainSession = record.sessionId as string;
      void this.drainPending({ sessionId: drainSession }).catch((err) => {
        this.options.logger?.warn("auto-drain after task create failed", {
          taskId: record.id,
          sessionId: drainSession,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return record;
  }

  /**
   * Execute one attempt of `taskId`. Returns the post-attempt record
   * regardless of outcome. Returns `null` when the task vanished or was
   * already claimed by a concurrent runner — callers must treat this as
   * "skipped, try the next one".
   */
  async runOne(
    taskId: string,
    runtimeSignal?: AbortSignal,
  ): Promise<TaskRecord | null> {
    const task = this.options.store.get(taskId);
    if (!task) return null;
    if (task.status !== "pending") return task;

    const resolvedTask = this.ensureSessionBeforeClaim(task);
    if (!resolvedTask) {
      return this.options.store.get(task.id);
    }

    const claimed = this.options.store.markRunning(resolvedTask.id);
    if (!claimed) return this.options.store.get(resolvedTask.id);

    this.options.metrics?.recordTaskStarted({
      taskId: claimed.id,
      sessionId: claimed.sessionId ?? "<unassigned>",
      origin: claimed.origin,
      attempt: claimed.attempts,
    });

    const session = this.loadOrRecreateSession(claimed);
    if (!session) {
      const blocked = this.options.store.markBlocked(claimed.id, {
        category: "tool",
        message: `session_not_found: ${claimed.sessionId ?? "<null>"}`,
      });
      this.recordTerminal(blocked);
      this.options.logger?.warn("task blocked: session not found", {
        taskId: blocked.id,
        sessionId: blocked.sessionId,
      });
      return blocked;
    }

    this.stampWakeReason(session, claimed);

    const maxSteps = claimed.maxSteps ?? this.options.defaultMaxSteps;
    try {
      const result = await this.options.runtime.runTurn(
        session,
        claimed.userMessage,
        {
          maxSteps,
          origin: "scheduler",
          ...(runtimeSignal ? { signal: runtimeSignal } : {}),
        },
      );
      // `runTurn` rejects on hard failures, but `loop_failed` results
      // surface as a `reason: "failed"` outcome instead — treat that
      // as the same retryable transport-class failure so the operator
      // sees a consistent retry curve.
      if (result.reason === "failed") {
        return this.handleFailure(claimed, "transport", new Error("loop reported failed"));
      }
      if (result.reason === "cancelled") {
        return this.handleCancelled(claimed, new Error("turn cancelled"));
      }
      const completed = this.options.store.markCompleted(claimed.id);
      this.recordTerminal(completed);
      return this.maybeRequeueRecurring(completed);
    } catch (err) {
      const category = classifyFailure(err);
      if (category === "cancelled") {
        return this.handleCancelled(claimed, err);
      }
      return this.handleFailure(claimed, category, err);
    }
  }

  /**
   * Pull every `pending` task (optionally filtered by `sessionId`),
   * group by session, and drain each group sequentially. Per-session
   * tasks see their backoff applied between attempts on the *same*
   * task. Cross-session groups run in parallel; `TurnController`
   * enforces at most one concurrent `runTurn` per session, which
   * naturally serialises this loop with any user-facing turn that lands
   * mid-drain.
   */
  async drainPending(opts: DrainOptions = {}): Promise<DrainOutcome> {
    if (!this.options.enabled) return emptyOutcome();
    const limit = opts.limit ?? 1_000;
    const pending = this.options.store.listPending({
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      limit,
    });
    return this.drainBatch(pending, opts.signal);
  }

  /**
   * Scheduler-facing drain. Identical per-session semantics as
   * `drainPending` but keyed off `listDue(now)` — the scheduler's sole
   * query path. Returns the same `DrainOutcome`; retry counters capture
   * within-attempt retries, not requeues of recurring tasks.
   */
  async runDue(
    now: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DrainOutcome> {
    if (!this.options.enabled) return emptyOutcome();
    const due = this.options.store.listDue(now, limit);
    return this.drainBatch(due, signal);
  }

  private async drainBatch(
    tasks: TaskRecord[],
    signal?: AbortSignal,
  ): Promise<DrainOutcome> {
    const outcome = emptyOutcome();
    if (tasks.length === 0) return outcome;
    const grouped = groupBySession(tasks);
    await Promise.all(
      [...grouped.values()].map((group) =>
        this.drainSessionGroup(group, signal, outcome),
      ),
    );
    return outcome;
  }

  private async drainSessionGroup(
    initialGroup: TaskRecord[],
    signal: AbortSignal | undefined,
    outcome: DrainOutcome,
  ): Promise<void> {
    for (const task of initialGroup) {
      if (signal?.aborted) return;
      let current: TaskRecord | null = task;
      while (current && current.status === "pending") {
        if (signal?.aborted) return;
        const before = current;
        current = await this.runOne(current.id, signal);
        outcome.drained += 1;
        if (!current) break;
        if (current.status === "completed") outcome.completed += 1;
        else if (current.status === "failed") outcome.failed += 1;
        else if (current.status === "blocked") outcome.blocked += 1;
        else if (current.status === "cancelled") outcome.cancelled += 1;
        else if (current.status === "pending") {
          // Distinguish recurring-requeue from within-attempt retry:
          // requeued recurring tasks have `attempts == 0` and a
          // fresh `scheduled_for`; they are not consumed in this
          // drain iteration (the scheduler picks them up later).
          if (
            current.recurring &&
            current.attempts === 0 &&
            current.scheduledFor !== null &&
            current.scheduledFor > Date.now()
          ) {
            outcome.completed += 1;
            break;
          }
          outcome.retried += 1;
          const delay = nextDelayMs(current.attempts, this.options.backoff);
          if (delay > 0) await this.sleep(delay);
          void before;
        }
      }
    }
  }

  private handleFailure(
    task: TaskRecord,
    category: LlmFailureCategory,
    err: unknown,
  ): TaskRecord {
    const message = err instanceof Error ? err.message : String(err);
    const failure = { category, message };
    if (isPermanent(category) || task.attempts >= task.maxAttempts) {
      const terminal = isPermanent(category)
        ? this.options.store.markBlocked(task.id, failure)
        : this.options.store.markFailed(task.id, failure);
      this.recordTerminal(terminal);
      this.options.logger?.warn("task terminal failure", {
        taskId: terminal.id,
        sessionId: terminal.sessionId,
        category,
        attempt: terminal.attempts,
        status: terminal.status,
        error: message,
      });
      return terminal;
    }
    const retried = this.options.store.markRetry(task.id, failure);
    this.options.metrics?.recordTaskRetry({
      taskId: retried.id,
      sessionId: retried.sessionId ?? "<unassigned>",
      category,
      attempt: retried.attempts,
    });
    this.options.logger?.info("task scheduled for retry", {
      taskId: retried.id,
      sessionId: retried.sessionId,
      category,
      attempt: retried.attempts,
      maxAttempts: retried.maxAttempts,
    });
    return retried;
  }

  private handleCancelled(task: TaskRecord, err: unknown): TaskRecord {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = this.options.store.cancel(task.id);
    if (!cancelled) {
      return { ...task, status: "cancelled" as TaskStatus, lastError: message };
    }
    this.recordTerminal(cancelled);
    return cancelled;
  }

  private recordTerminal(task: TaskRecord): void {
    if (!this.options.metrics) return;
    if (!isTerminal(task.status)) return;
    const durationMs =
      task.completedAt !== null && task.startedAt !== null
        ? task.completedAt - task.startedAt
        : 0;
    this.options.metrics.recordTaskTerminal({
      taskId: task.id,
      sessionId: task.sessionId ?? "<unassigned>",
      origin: task.origin,
      status: task.status,
      attempts: task.attempts,
      durationMs,
    });
  }

  /**
   * Lazy session creation path for one-shot tasks created without an
   * explicit `sessionId`. Invoked just before `markRunning` so the
   * claim sees a stable row. Returns the updated record, or `null`
   * when the row is missing after the write.
   */
  private ensureSessionBeforeClaim(task: TaskRecord): TaskRecord | null {
    if (task.sessionId !== null) return task;
    if (!this.options.sessionFactory) {
      this.options.store.markBlocked(task.id, {
        category: "tool",
        message: "session_not_found: task has no session_id and no sessionFactory wired",
      });
      return null;
    }
    const fresh = this.options.sessionFactory.create({
      metadata: {
        ephemeralTask: true,
        triggerSource: task.triggerSource ?? undefined,
      },
    });
    this.options.metrics?.recordTaskSessionAutoCreated({
      sessionId: fresh.id,
      reason: "one_shot_lazy",
    });
    return this.options.store.assignSession(task.id, fresh.id);
  }

  /**
   * Load the task's session. Recurring tasks auto-recreate a fresh
   * session if the previous one has been deleted since the last
   * firing; one-shot tasks fall through to the `session_not_found`
   * block path. Returns `null` when neither branch can produce a
   * session so the caller can block the task.
   */
  private loadOrRecreateSession(task: TaskRecord): SessionState | null {
    if (task.sessionId === null) return null;
    const existing = this.options.sessionLoader.load(task.sessionId);
    if (existing) return existing;
    if (!task.recurring || !this.options.sessionFactory) return null;
    const fresh = this.options.sessionFactory.create({
      metadata: {
        recurringTask: true,
        recreatedFrom: task.sessionId,
      },
    });
    this.options.store.assignSession(task.id, fresh.id);
    this.options.logger?.warn("recurring task session recreated", {
      taskId: task.id,
      previousSessionId: task.sessionId,
      newSessionId: fresh.id,
    });
    this.options.metrics?.recordTaskSessionRecreated({
      taskId: task.id,
      previousSessionId: task.sessionId,
      newSessionId: fresh.id,
    });
    return fresh;
  }

  /**
   * Stamp `session.metadata.wakeReason` just before `runTurn` so the
   * agent loop and any downstream trace consumer can distinguish
   * user-initiated turns from scheduler / webhook / agent-initiated
   * ones. Persisted via `sessionFactory.save` so the metadata survives
   * restarts. No-op when no factory is wired (tests).
   */
  private stampWakeReason(session: SessionState, task: TaskRecord): void {
    if (!this.options.sessionFactory) return;
    const source = mapTriggerSource(task.triggerSource, task.origin);
    const wakeReason: Record<string, unknown> = {
      source,
      taskId: task.id,
      at: Date.now(),
    };
    const metadataWebhookName = session.metadata?.webhookName;
    if (typeof metadataWebhookName === "string" && metadataWebhookName.length > 0) {
      wakeReason.webhookName = metadataWebhookName;
    }
    session.metadata = {
      ...(session.metadata ?? {}),
      wakeReason,
    };
    this.options.sessionFactory.save(session);
  }

  /**
   * Happy-path hook for recurring tasks. After `markCompleted`, if the
   * task is recurring and carries a schedule, compute the next firing
   * and atomically transition the row back to `pending` with a fresh
   * `scheduled_for`. `session_id` is preserved so the next firing
   * lands on the same persistent session.
   */
  private maybeRequeueRecurring(completed: TaskRecord): TaskRecord {
    if (!completed.recurring || !completed.schedule) return completed;
    const next = resolveNextRecurring(completed.schedule, completed.completedAt);
    const requeued = this.options.store.requeueRecurring(completed.id, next);
    this.options.metrics?.recordTaskRecurringRequeued({
      taskId: requeued.id,
      sessionId: requeued.sessionId ?? "<unassigned>",
      nextScheduledFor: next,
    });
    this.options.logger?.info("recurring task requeued", {
      taskId: requeued.id,
      sessionId: requeued.sessionId,
      nextScheduledFor: next,
    });
    return requeued;
  }
}

function isTerminal(
  status: TaskStatus,
): status is "completed" | "failed" | "blocked" | "cancelled" {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  );
}

function groupBySession(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const out = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const key = t.sessionId ?? `__nosession__:${t.id}`;
    const list = out.get(key);
    if (list) list.push(t);
    else out.set(key, [t]);
  }
  return out;
}

/**
 * Failure categories that are not worth retrying with the same input —
 * `grammar` and `tool` failures will keep failing identically because
 * the user message and tool catalog are unchanged between attempts.
 */
function isPermanent(category: LlmFailureCategory): boolean {
  return category === "grammar" || category === "tool";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyOutcome(): DrainOutcome {
  return {
    drained: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    retried: 0,
  };
}

function resolveNextRecurring(
  schedule: TaskSchedule,
  completedAt: number | null,
): number {
  const base = completedAt ?? Date.now();
  return resolveScheduledFor(schedule, base);
}

/**
 * Bridge between the task's informational `triggerSource` and the
 * wake-reason enum rendered on session metadata. `origin` is a
 * fallback — e.g. a CLI-created task without an explicit trigger
 * source defaults to `user`.
 */
function mapTriggerSource(
  triggerSource: TriggerSource | null,
  origin: TaskRecord["origin"],
): TriggerSource {
  if (triggerSource) return triggerSource;
  if (origin === "scheduler") return "scheduler";
  return "user";
}
