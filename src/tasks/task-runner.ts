import { classifyFailure } from "../llm/reliability/index.js";
import type { LlmFailureCategory } from "../llm/reliability/index.js";
import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-contract.js";
import type { SessionState } from "../session/index.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { TurnEventHook, TurnOrigin } from "../runtime/turn-controller.js";

import { nextDelayMs, type BackoffOptions } from "./task-backoff.js";
import {
  planTaskResume,
  type TaskResumePlan,
  type TaskResumePolicy,
} from "./task-resume.js";
import type { TurnProgress } from "../session/turn-progress.js";
import {
  buildTaskReport,
  isReportableStatus,
  taskReportRunFrom,
  type TaskReportRun,
  type TaskReportSink,
} from "./task-report.js";
import {
  createTaskRunSummaryCollector,
  type TaskLiveStatus,
  type TaskRunSummaryCollector,
} from "./task-run-summary.js";
import { isRecurring, resolveScheduledFor } from "./task-schedule.js";
import { approvalLevelAllows, formatRunTime, remainingCostUsd, remainingDurationMs } from "./task-budget.js";
import { formatUsd } from "../llm/provider/usage-cost.js";
import { startTaskSnapshots, type TaskSnapshotSink } from "./task-snapshot.js";
import {
  TaskValidationError,
  type TaskRecord,
  type TaskSchedule,
  type TaskStatus,
  type TriggerSource,
} from "./task-types.js";
import type { TaskCreateInput, TaskStore } from "./task-store.js";
import { TASK_OWNER_GONE_ERROR } from "./task-store.js";

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
      /** The progress marker's task id, resumes and request (ATO-1109). */
      checkpoint?: { taskId?: string; resumes?: number; request?: string };
      /** The task's own wall-clock ceiling (`TaskRecord.maxDurationMs`). */
      taskMaxDurationMs?: number;
      /** What the task may still spend, USD (`TaskRecord.maxCostUsd`). */
      taskMaxCostUsd?: number;
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
  /**
   * `agent.task.maxSteps`: used instead of `defaultMaxSteps` by a task
   * that has a money or time budget but no step count, so the budget
   * ends it and not the per-leg step default.
   */
  budgetedMaxSteps?: number;
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
  /**
   * `tasks.minIntervalMs`: the operator's floor on a new `interval`
   * schedule's `everyMs`, on top of the fixed 1 000 ms in
   * `task-schedule.ts`. Checked at `create` only, so raising it never
   * strands a task that already runs at a shorter interval.
   */
  minIntervalMs?: number;
  /**
   * Terminal-outcome delivery for tasks that opted in via
   * `TaskRecord.notify`. Optional: without a sink the `notify` flag
   * is inert (tasks finish silently, same as before v3).
   */
  reportSink?: TaskReportSink;
  /**
   * Auto status snapshots of long reporting runs (ATO-965): every
   * `snapshotCadence.everySteps` steps or `everyMs` of wall time, the
   * live status goes to this sink (Telegram edits one message per task).
   * Only tasks that report (`notify` set and a `reportSink` wired) have
   * a live status to send. Absent sink or cadence: off.
   */
  snapshotSink?: TaskSnapshotSink;
  snapshotCadence?: { everySteps: number; everyMs: number } | null;
  logger?: StructuredLogger;
  /**
   * This process's live approval level (ATO-1324). A task that recorded
   * another level than this one is blocked with `approval_level_mismatch:`
   * instead of run. Omitted (tests, hosts without a gate): no check.
   */
  approvalLevel?: () => number;
  /**
   * Sleep inhibitor held while a drain runs (ATO-592,
   * `tasks.keepAwake`, `src/scheduler/keep-awake.ts`). Absent or `off`:
   * the computer may sleep mid-task, as before.
   */
  keepAwake?: { hold(): () => void };
  metrics?: AgentMetrics;
  /**
   * Test seam for the inter-attempt sleep. Production uses the real
   * `setTimeout`; tests substitute a fake to keep the suite fast.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Continue a run cut off by a crash, a kill or a restart instead of
   * starting it over (`task-resume.ts`, ATO-1109): the policy
   * (`agent.task.resumeInterrupted`, `agent.task.maxResumes`) and the
   * session store's progress markers. Absent: every run starts fresh,
   * as before.
   */
  resume?: TaskResumePolicy & {
    progress: {
      read(sessionId: string): TurnProgress | null;
      clear(sessionId: string): void;
    };
  };
}

export interface DrainOptions {
  sessionId?: string;
  /** Hard upper bound on the number of pending tasks consumed in this drain. */
  limit?: number;
  /**
   * Optional cancellation. When fired the drain stops at the next
   * task boundary, and the in-flight task's turn is aborted; that task
   * goes back to `pending` for a later run (`handleCancelled`).
   */
  signal?: AbortSignal;
}

/** A run `runOne` has in progress, for `cancel` and `stop` to abort. */
interface InFlightRun {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  ended: boolean;
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
  /**
   * The runs in progress, by task id. A task is claimed by one run at a
   * time (`markRunning` only claims a `pending` row), so the id is enough.
   */
  private readonly runs = new Map<string, InFlightRun>();
  /** Set by `stop`: nothing is claimed after it. */
  private stopping = false;
  /** Summary collectors of the runs in progress, for `liveStatus`. */
  private readonly live = new Map<
    string,
    Omit<TaskLiveStatus, "summary"> & { collector: TaskRunSummaryCollector }
  >();

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
    const minIntervalMs = this.options.minIntervalMs;
    if (
      schedule?.kind === "interval" &&
      minIntervalMs !== undefined &&
      typeof schedule.everyMs === "number" &&
      schedule.everyMs < minIntervalMs
    ) {
      throw new TaskValidationError(
        "schedule",
        `schedule.everyMs must be >= ${minIntervalMs} (tasks.minIntervalMs)`,
      );
    }
    const scheduledFor =
      schedule && input.scheduledFor === undefined
        ? resolveScheduledFor(schedule, now)
        : (input.scheduledFor ?? null);

    let sessionId: string | null | undefined = input.sessionId ?? null;
    if (
      sessionId === null &&
      isRecurring(schedule) &&
      this.options.sessionFactory
    ) {
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
    if (this.stopping) return null;
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
      this.maybeReport(blocked, null);
      this.options.logger?.warn("task blocked: session not found", {
        taskId: blocked.id,
        sessionId: blocked.sessionId,
      });
      return blocked;
    }

    // A budget the earlier attempts already used up (ATO-1108): running
    // again would only spend more, so the task waits for an operator.
    const costLeft = remainingCostUsd(claimed);
    if (costLeft === "exhausted") {
      const blocked = this.options.store.markBlocked(claimed.id, {
        category: "tool",
        message:
          `budget_spent: ${formatUsd(claimed.spentUsd ?? 0)} of ` +
          `${formatUsd(claimed.maxCostUsd ?? 0)} already spent by earlier attempts`,
      });
      this.recordTerminal(blocked);
      this.maybeReport(blocked, null);
      return blocked;
    }

    // Started under another approval level (an interrupted overnight
    // run, ATO-1324): resuming it here would allow what it denied, or
    // wait for a person who is not there. Blocked with a plain reason
    // rather than left pending, where it would sit at the head of the
    // due queue forever and hold up every other task.
    const processLevel = this.options.approvalLevel?.();
    if (!approvalLevelAllows(claimed, processLevel)) {
      const blocked = this.options.store.markBlocked(claimed.id, {
        category: "tool",
        message:
          `approval_level_mismatch: started at approval level ${claimed.approvalLevel}, ` +
          `this agent runs at ${processLevel}; start it again with \`atomic-agent overnight\``,
      });
      this.recordTerminal(blocked);
      this.maybeReport(blocked, null);
      return blocked;
    }

    // The same for the time limit: a resume after a restart, clean or
    // not, gets what is left of it, not a new one.
    const timeLeft = remainingDurationMs(claimed);
    if (timeLeft === "exhausted") {
      const blocked = this.options.store.markBlocked(claimed.id, {
        category: "tool",
        message:
          `time_spent: ${formatRunTime(claimed.elapsedMs ?? 0)} of ` +
          `${formatRunTime(claimed.maxDurationMs ?? 0)} already used by earlier attempts`,
      });
      this.recordTerminal(blocked);
      this.maybeReport(blocked, null);
      return blocked;
    }

    this.stampWakeReason(session, claimed);

    // `task` is the row as it was before the claim, which cleared the
    // reason it was put back for.
    const plan = this.planResume(task, session.id);
    if (plan.kind === "give_up") {
      return this.giveUpResuming(claimed, plan, session.id);
    }

    // Collect what the run does from the turn's own events (ATO-964):
    // the final reply (the `reply` terminal's `assistant_reply`, or the
    // `finish` tool's summary — unattended tasks routinely end via
    // `finish`), files changed, commands and their exits, errors,
    // approvals. Installed only when this task opted into reporting AND
    // a sink is wired — every other task pays zero per-event cost (no
    // hook is passed at all), and only reporting tasks show in
    // `liveStatus`.
    const collector =
      claimed.notify !== null && this.options.reportSink
        ? createTaskRunSummaryCollector()
        : null;
    const liveInfo = {
      taskId: claimed.id,
      userMessage: claimed.userMessage,
      startedAt: claimed.startedAt ?? Date.now(),
    };
    const snapshots =
      collector && this.options.snapshotSink
        ? startTaskSnapshots({
            sink: this.options.snapshotSink,
            cadence: this.options.snapshotCadence,
            live: liveInfo,
            collector,
            onError: (err) =>
              this.options.logger?.warn("task snapshot sink failed", {
                taskId: claimed.id,
                error: err instanceof Error ? err.message : String(err),
              }),
          })
        : null;
    const reportHook: TurnEventHook | undefined = collector
      ? (event: AgentLoopEvent): void => {
          collector.onEvent(event);
          snapshots?.onEvent(event);
        }
      : undefined;
    const runFacts = (result: RunTurnResult | null): TaskReportRun =>
      taskReportRunFrom(result, collector?.snapshot() ?? null);

    // A task with a spend ceiling has its spend written step by step
    // (ATO-1108), not only when the turn returns: a run that throws, or
    // a process that dies mid-run, must not hand the next attempt the
    // whole budget again. `step_finished.spendUsd` is the turn's running
    // total, so the latest one stands for this run.
    const spentBefore = claimed.spentUsd ?? 0;
    const spendHook: TurnEventHook | undefined =
      claimed.maxCostUsd !== null
        ? (event: AgentLoopEvent): void => {
            if (event.type !== "step_finished" || event.spendUsd === undefined) return;
            this.options.store.recordSpend(claimed.id, spentBefore + event.spendUsd);
          }
        : undefined;
    // Run time is written the same way, so a process that dies mid-run
    // loses at most the step it was on.
    const elapsedBefore = claimed.elapsedMs ?? 0;
    let runStartedAt: number | null = null;
    const recordElapsed = (): void => {
      if (claimed.maxDurationMs === null || runStartedAt === null) return;
      this.options.store.recordElapsed(
        claimed.id,
        elapsedBefore + (Date.now() - runStartedAt),
      );
    };
    const elapsedHook: TurnEventHook | undefined =
      claimed.maxDurationMs !== null
        ? (event: AgentLoopEvent): void => {
            if (event.type === "step_finished") recordElapsed();
          }
        : undefined;
    const hooks = [reportHook, spendHook, elapsedHook].filter(
      (hook): hook is TurnEventHook => hook !== undefined,
    );
    const eventHook: TurnEventHook | undefined =
      hooks.length > 0
        ? (event: AgentLoopEvent): void => {
            for (const hook of hooks) hook(event);
          }
        : undefined;

    const hasBudget = claimed.maxCostUsd !== null || claimed.maxDurationMs !== null;
    const maxSteps =
      claimed.maxSteps ??
      (hasBudget ? this.options.budgetedMaxSteps : undefined) ??
      this.options.defaultMaxSteps;
    // Every run gets a stop of its own: an operator cancelling the task
    // (`cancel`), the runner stopping for shutdown (`stop`), and the
    // drain's signal — the scheduler aborts its own when the agent quits
    // — all end the turn through it.
    const run = this.beginRun(claimed.id, runtimeSignal);
    // Set once the turn is about to start. A crash resume stopped before
    // that (during its backoff) never wrote its resume count into the
    // session's marker (`beginTurn` does), so the task goes back still
    // marked as taken back from a dead agent and the next boot counts
    // that crash again; otherwise quitting during the wait would reset
    // the count `agent.task.maxResumes` is checked against.
    let turnStarted = false;
    if (collector) {
      this.live.set(claimed.id, { ...liveInfo, collector });
    }
    try {
      let result: RunTurnResult;
      try {
        await this.backOffResume(plan, run.signal);
        if (run.signal.aborted) throw new Error("stopped before resuming");
        turnStarted = true;
        runStartedAt = Date.now();
        result = await this.options.runtime.runTurn(
          session,
          plan.kind === "resume" ? plan.message : claimed.userMessage,
          {
            maxSteps,
            origin: "scheduler",
            signal: run.signal,
            ...(eventHook ? { eventHook } : {}),
            ...(timeLeft !== undefined ? { taskMaxDurationMs: timeLeft } : {}),
            ...(costLeft !== undefined ? { taskMaxCostUsd: costLeft } : {}),
            checkpoint: {
              taskId: claimed.id,
              resumes: plan.kind === "resume" ? plan.resumes : 0,
              request: claimed.userMessage,
            },
          },
        );
      } catch (err) {
        recordElapsed();
        if (this.endedElsewhere(claimed)) {
          return this.options.store.get(claimed.id);
        }
        const category = classifyFailure(err);
        // An abort can surface as any error on its way out of the turn;
        // once this run was stopped, that is what ended it.
        if (category === "cancelled" || run.signal.aborted) {
          return this.handleCancelled(
            claimed,
            err,
            this.interrupted(runtimeSignal),
            !turnStarted && plan.kind === "resume" && plan.crashed
              ? TASK_OWNER_GONE_ERROR
              : undefined,
          );
        }
        return this.handleFailure(claimed, category, err, runFacts(null));
      }
      recordElapsed();
      // What this run spent joins what earlier attempts spent, whatever
      // the outcome: the morning report and a retry's budget read it.
      if (result.spendUsd !== undefined) {
        this.options.store.recordSpend(claimed.id, spentBefore + result.spendUsd);
      }
      // An operator cancelled the task while its turn ran — here, or from
      // another process, which cannot reach this turn — and that stands:
      // the outcome is not written over it.
      if (this.endedElsewhere(claimed)) {
        return this.options.store.get(claimed.id);
      }
      // `runTurn` rejects on hard failures, but `loop_failed` results
      // surface as a `reason: "failed"` outcome instead — treat that
      // as the same retryable transport-class failure so the operator
      // sees a consistent retry curve.
      // A steer accepted by this turn but never delivered must not vanish
      // just because the turn belonged to the scheduler: there is no host
      // to hand it to, so the structured log is the surface of record.
      if (result.undelivered !== undefined && result.undelivered.length > 0) {
        this.options.logger?.warn?.(
          "steering messages stranded by a task turn",
          {
            taskId: claimed.id,
            count: result.undelivered.length,
            preview: result.undelivered[0]?.slice(0, 120),
          },
        );
      }
      if (
        result.reason === "cancelled" ||
        (result.reason === "failed" && run.signal.aborted)
      ) {
        return this.handleCancelled(
          claimed,
          new Error("turn cancelled"),
          this.interrupted(runtimeSignal),
        );
      }
      if (result.reason === "failed") {
        return this.handleFailure(
          claimed,
          "transport",
          new Error("loop reported failed"),
          runFacts(result),
        );
      }
      // `completed` also covers a run a ceiling ended; the row says which,
      // so a reader does not take unfinished work for finished.
      if (result.stopCause !== undefined) {
        this.options.store.recordStopCause(claimed.id, result.stopCause);
      }
      const completed = this.options.store.markCompleted(claimed.id);
      this.recordTerminal(completed);
      // Report off the completed row BEFORE the recurring requeue —
      // the requeued row is `pending` again and would fail the
      // terminal-status guard inside `maybeReport`.
      const facts = runFacts(result);
      this.maybeReport(completed, facts.summary?.replyText ?? null, facts);
      return this.maybeRequeueRecurring(completed);
    } finally {
      snapshots?.stop();
      this.live.delete(claimed.id);
      run.end();
    }
  }

  /**
   * How to start `task`'s run (`planTaskResume`): fresh, continued from
   * its session's checkpoint, or not at all. Reading the marker is
   * bookkeeping; a store that cannot answer means a fresh run.
   */
  private planResume(task: TaskRecord, sessionId: string): TaskResumePlan {
    const resume = this.options.resume;
    if (resume === undefined) return { kind: "fresh" };
    let progress: TurnProgress | null = null;
    try {
      progress = resume.progress.read(sessionId);
    } catch (err) {
      this.options.logger?.warn("could not read the task's checkpoint; running it fresh", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const plan = planTaskResume(task, progress, resume);
    if (plan.kind === "resume") {
      this.options.logger?.info("task run interrupted earlier; resuming from its checkpoint", {
        taskId: task.id,
        sessionId,
        stepsDone: progress?.stepsDone,
        resumes: plan.resumes,
        crashed: plan.crashed,
      });
    }
    return plan;
  }

  /**
   * Crash resumes after the first wait before they start, on the retry
   * curve (`nextDelayMs`): a task that takes the agent down every time
   * is not run again the instant the agent is back. The run's own stop
   * ends the wait.
   */
  private async backOffResume(
    plan: TaskResumePlan,
    signal: AbortSignal,
  ): Promise<void> {
    if (plan.kind !== "resume" || !plan.crashed || plan.resumes < 2) return;
    const delay = nextDelayMs(plan.resumes - 1, this.options.backoff);
    if (delay <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      void this.sleep(delay).then(done, done);
    });
  }

  /**
   * The agent stopped under this task more times than
   * `agent.task.maxResumes` allows: fail it with a sentence saying so,
   * and drop the checkpoint, rather than claim it at every boot for ever.
   */
  private giveUpResuming(
    task: TaskRecord,
    plan: Extract<TaskResumePlan, { kind: "give_up" }>,
    sessionId: string,
  ): TaskRecord {
    const failed = this.options.store.markFailed(task.id, {
      category: "transport",
      message: plan.message,
    });
    try {
      this.options.resume?.progress.clear(sessionId);
    } catch {
      // The marker is only read for this task; a stale one is harmless.
    }
    this.recordTerminal(failed);
    this.maybeReport(failed, null);
    this.options.logger?.warn("task interrupted too many times; failed", {
      taskId: failed.id,
      sessionId: failed.sessionId,
      resumes: plan.resumes,
    });
    return failed;
  }

  /**
   * What each task this runner is running right now has done so far
   * (ATO-965): the same deterministic summary the final report carries,
   * snapshotted mid-run. Oldest run first. Read by Telegram `/status`.
   */
  liveStatus(): TaskLiveStatus[] {
    return [...this.live.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ collector, ...rest }) => ({ ...rest, summary: collector.snapshot() }));
  }

  /**
   * Cancel a task for an operator: `DELETE /api/tasks/:id`, the TUI's
   * tasks tab. Same answer as `TaskStore.cancel`, and on a task whose
   * run is in progress here it also stops that run's turn — before this
   * the row said `cancelled` while the turn went on to its end.
   *
   * The row is cancelled first and the turn aborted after, so the run
   * unwinding finds the row already ended (`endedElsewhere`) and leaves
   * it: a cancelled task is never retried, and a recurring one is never
   * rearmed. A run in another process (the CLI's `task cancel` writes
   * the row from outside) is not reached; it ends on its own and finds
   * the row cancelled the same way.
   */
  cancel(id: string, now: number = Date.now()): TaskRecord | null {
    const record = this.options.store.cancel(id, now);
    if (record?.status === "cancelled") {
      this.runs.get(id)?.controller.abort();
    }
    return record;
  }

  /**
   * Stop for shutdown: claim nothing more, abort the turn of every run
   * in progress, and wait at most `graceMs` for each to put its task
   * back (`handleCancelled` — a recurring task is rearmed for its next
   * firing, a one-shot one left due for the next start). A stopped turn
   * comes back in milliseconds; the bound is for one stuck in work that
   * ignores its signal. Before this nothing stopped a task's turn at
   * shutdown, which waited for it — on a model server that was not
   * answering, until the host gave up and killed the agent.
   *
   * Resolves to how many runs were still going when the wait gave up.
   * Their rows stay `running` under this process, and the next boot's
   * sweep takes them back once it is gone (`recoverInterrupted`). The
   * timer is not `unref`'d, for the reason `TurnsInFlight` gives.
   */
  async stop(graceMs: number): Promise<number> {
    this.stopping = true;
    const runs = [...this.runs.values()];
    if (runs.length === 0) return 0;
    for (const run of runs) run.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([
        Promise.all(runs.map((run) => run.settled)),
        graceOver,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return runs.filter((run) => !run.ended).length;
  }

  /**
   * Register the run `runOne` is starting on `taskId`; `end()` once its
   * outcome is written. Its signal aborts with `outer` (the drain's).
   */
  private beginRun(
    taskId: string,
    outer: AbortSignal | undefined,
  ): { signal: AbortSignal; end(): void } {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort(outer?.reason);
    if (this.stopping || outer?.aborted === true) {
      controller.abort(outer?.reason);
    } else {
      outer?.addEventListener("abort", onOuterAbort, { once: true });
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const run: InFlightRun = { controller, settled, ended: false };
    this.runs.set(taskId, run);
    return {
      signal: controller.signal,
      end: () => {
        if (run.ended) return;
        run.ended = true;
        outer?.removeEventListener("abort", onOuterAbort);
        if (this.runs.get(taskId) === run) this.runs.delete(taskId);
        resolveSettled();
      },
    };
  }

  /**
   * Whether the row a run claimed is no longer that run's: ended by
   * something else since — an operator's cancel — gone, or claimed
   * afresh (`started_at` moved; the boot sweep of a runtime started
   * after this one gave up on it). The run then writes nothing.
   */
  private endedElsewhere(claimed: TaskRecord): boolean {
    const row = this.options.store.get(claimed.id);
    return (
      row === null ||
      row.status !== "running" ||
      row.startedAt !== claimed.startedAt
    );
  }

  /**
   * Whether a run that ended cancelled was stopped from outside the task
   * — the agent shutting down (`stop`), or the drain it ran in being
   * aborted — rather than by its own turn being stopped.
   */
  private interrupted(runtimeSignal: AbortSignal | undefined): boolean {
    return this.stopping || runtimeSignal?.aborted === true;
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
    const release = this.options.keepAwake?.hold();
    try {
      await Promise.all(
        [...grouped.values()].map((group) =>
          this.drainSessionGroup(group, signal, outcome),
        ),
      );
    } finally {
      release?.();
    }
    return outcome;
  }

  private async drainSessionGroup(
    initialGroup: TaskRecord[],
    signal: AbortSignal | undefined,
    outcome: DrainOutcome,
  ): Promise<void> {
    for (const task of initialGroup) {
      if (signal?.aborted || this.stopping) return;
      let current: TaskRecord | null = task;
      while (current && current.status === "pending") {
        if (signal?.aborted || this.stopping) return;
        const before = current;
        current = await this.runOne(current.id, signal);
        outcome.drained += 1;
        if (!current) break;
        if (current.status === "completed") outcome.completed += 1;
        else if (current.status === "failed") outcome.failed += 1;
        else if (current.status === "blocked") outcome.blocked += 1;
        else if (current.status === "cancelled") outcome.cancelled += 1;
        else if (current.status === "pending") {
          // Put back by an interrupted run (`handleCancelled`): it runs
          // again at its next firing or the next start, never straight
          // away in this drain.
          if (current.lastErrorCategory === "cancelled") {
            outcome.cancelled += 1;
            break;
          }
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
    run?: TaskReportRun,
  ): TaskRecord {
    const message = err instanceof Error ? err.message : String(err);
    const failure = { category, message };
    if (isPermanent(category) || task.attempts >= task.maxAttempts) {
      const terminal = isPermanent(category)
        ? this.options.store.markBlocked(task.id, failure)
        : this.options.store.markFailed(task.id, failure);
      this.recordTerminal(terminal);
      this.maybeReport(terminal, run?.summary?.replyText ?? null, run);
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

  /**
   * A run whose turn ended cancelled, the row still `running` (an
   * operator's cancel is caught before this, in `runOne`).
   *
   *  - A recurring task is rearmed for its next firing: one firing was
   *    stopped — the agent quitting, the turn stopped from its chat —
   *    and the schedule goes on. It used to be cancelled for good.
   *  - A one-shot task stopped from outside (`interrupted`: shutdown, an
   *    aborted drain) is left due, so the next start runs it — what the
   *    boot sweep did for it when shutdown still let the process be
   *    killed under the turn.
   *  - A one-shot task whose own turn was stopped is cancelled.
   */
  private handleCancelled(
    task: TaskRecord,
    err: unknown,
    interrupted: boolean,
    /** `last_error` for a one-shot task put back (`markInterrupted`). */
    interruptedError?: string,
  ): TaskRecord | null {
    const message = err instanceof Error ? err.message : String(err);
    if (task.recurring && task.schedule) {
      const next = resolveScheduledFor(task.schedule, Date.now());
      const requeued = this.options.store.markInterrupted(task.id, {
        nextScheduledFor: next,
      });
      if (!requeued) return this.options.store.get(task.id);
      this.options.metrics?.recordTaskRecurringRequeued({
        taskId: requeued.id,
        sessionId: requeued.sessionId ?? "<unassigned>",
        nextScheduledFor: next,
      });
      this.options.logger?.info("recurring task run interrupted; requeued", {
        taskId: requeued.id,
        sessionId: requeued.sessionId,
        nextScheduledFor: next,
        reason: message,
      });
      return requeued;
    }
    if (interrupted) {
      const pending = this.options.store.markInterrupted(task.id, {
        nextScheduledFor: null,
        ...(interruptedError !== undefined
          ? { lastError: interruptedError }
          : {}),
      });
      if (!pending) return this.options.store.get(task.id);
      this.options.logger?.info("task run interrupted; left pending", {
        taskId: pending.id,
        sessionId: pending.sessionId,
        attempt: pending.attempts,
        reason: message,
      });
      return pending;
    }
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
   * Hand a terminal outcome to the report sink when the task opted in.
   * Fires at the same sites as the terminal metrics, minus `cancelled`
   * (see `TaskReportStatus`) and minus the pre-claim block inside
   * `ensureSessionBeforeClaim` (only reachable when no `sessionFactory`
   * is wired, i.e. test-only setups — production wiring always
   * supplies one). Fire-and-forget: a rejecting or throwing sink is
   * warn-logged and never alters the task's status or the drain.
   */
  private maybeReport(
    task: TaskRecord,
    replyText: string | null,
    run?: TaskReportRun,
  ): void {
    const sink = this.options.reportSink;
    if (!sink || task.notify === null) return;
    if (!isReportableStatus(task.status)) return;
    const report = buildTaskReport(task, task.status, replyText, run);
    void (async () => sink(report))().catch((err) => {
      this.options.logger?.warn("task report sink failed", {
        taskId: task.id,
        notify: task.notify,
        error: err instanceof Error ? err.message : String(err),
      });
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
        message:
          "session_not_found: task has no session_id and no sessionFactory wired",
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
    if (
      typeof metadataWebhookName === "string" &&
      metadataWebhookName.length > 0
    ) {
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
    const next = resolveNextRecurring(
      completed.schedule,
      completed.completedAt,
    );
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
