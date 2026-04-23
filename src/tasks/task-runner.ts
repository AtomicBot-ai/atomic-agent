import { classifyFailure } from "../llm/reliability/index.js";
import type { LlmFailureCategory } from "../llm/reliability/index.js";
import type { RunTurnResult } from "../agent/agent-loop.js";
import type { SessionState } from "../session/index.js";
import type { StructuredLogger } from "../telemetry/structured-logger.js";
import type { AgentMetrics } from "../telemetry/agent-metrics.js";
import type { TurnEventHook, TurnOrigin } from "../runtime/turn-controller.js";

import { nextDelayMs, type BackoffOptions } from "./task-backoff.js";
import type { TaskRecord, TaskStatus } from "./task-types.js";
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

export interface TaskRunnerOptions {
  store: TaskStore;
  runtime: TaskRunnerRuntime;
  sessionLoader: TaskRunnerSessionLoader;
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
 * Drives the durable task queue. Two surfaces:
 *
 *  - `runOne(taskId)` — atomically claim and execute a single attempt.
 *    Decides between `completed` / `failed` / `blocked` / `cancelled` /
 *    re-queued-`pending` based on the canonical `LlmFailureCategory`.
 *
 *  - `drainPending(opts)` — pull all pending tasks (optionally filtered
 *    by `sessionId`), group by session, and drain each group
 *    sequentially while different sessions run in parallel. Per-session
 *    FIFO is enforced both here and downstream by `TurnController`;
 *    cross-session parallelism is inherited verbatim from
 *    `TurnController`.
 *
 * No background timers, no `setInterval`. The drain is always triggered
 * explicitly (CLI, HTTP) or implicitly on `create` when the operator
 * opted into `tasks.runOnCreate`.
 */
export class TaskRunner {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TaskRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Persist a new task and (when `runOnCreate=true`) schedule an
   * immediate drain for its session. The drain is detached — callers
   * never await `runTurn` from inside `create`. Returns the freshly
   * persisted row.
   */
  create(input: TaskCreateInput): TaskRecord {
    const record = this.options.store.create(input);
    this.options.metrics?.recordTaskCreated({
      taskId: record.id,
      sessionId: record.sessionId,
      origin: record.origin,
    });
    if (this.options.enabled && this.options.runOnCreate) {
      void this.drainPending({ sessionId: record.sessionId }).catch((err) => {
        this.options.logger?.warn("auto-drain after task create failed", {
          taskId: record.id,
          sessionId: record.sessionId,
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

    const claimed = this.options.store.markRunning(task.id);
    if (!claimed) return this.options.store.get(task.id);

    this.options.metrics?.recordTaskStarted({
      taskId: claimed.id,
      sessionId: claimed.sessionId,
      origin: claimed.origin,
      attempt: claimed.attempts,
    });

    const session = this.options.sessionLoader.load(claimed.sessionId);
    if (!session) {
      const blocked = this.options.store.markBlocked(claimed.id, {
        category: "tool",
        message: `session_not_found: ${claimed.sessionId}`,
      });
      this.recordTerminal(blocked);
      this.options.logger?.warn("task blocked: session not found", {
        taskId: blocked.id,
        sessionId: blocked.sessionId,
      });
      return blocked;
    }

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
      return completed;
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
    const outcome: DrainOutcome = {
      drained: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      retried: 0,
    };
    if (!this.options.enabled) return outcome;

    const limit = opts.limit ?? 1_000;
    const pending = this.options.store.listPending({
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      limit,
    });
    if (pending.length === 0) return outcome;

    const grouped = groupBySession(pending);
    await Promise.all(
      [...grouped.values()].map((group) =>
        this.drainSessionGroup(group, opts.signal, outcome),
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
          outcome.retried += 1;
          const delay = nextDelayMs(current.attempts, this.options.backoff);
          if (delay > 0) await this.sleep(delay);
          // Loop again so the same drain pass keeps retrying until the
          // task settles or hits `maxAttempts`. The `before` reference
          // exists only to signal intent; the actual state machine
          // lives on the row itself.
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
      sessionId: retried.sessionId,
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
      // Only happens when the row vanished between markRunning and the
      // catch — extremely unlikely, surface a synthetic record so the
      // caller can keep iterating.
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
      sessionId: task.sessionId,
      origin: task.origin,
      status: task.status,
      attempts: task.attempts,
      durationMs,
    });
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
    const list = out.get(t.sessionId);
    if (list) list.push(t);
    else out.set(t.sessionId, [t]);
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
