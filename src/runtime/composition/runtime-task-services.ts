import { resolve } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import {
  parseQuietHours,
  SqliteHeldReportStore,
  TaskReportHold,
  TaskRunner,
  TaskStore,
  type TaskReportSink,
} from "../../tasks/index.js";
import type { TaskRunnerRuntime } from "../../tasks/task-runner.js";
import { createSchedulerLeadership, Scheduler } from "../../scheduler/index.js";
import { WebhookSessionStore, WEBHOOK_SESSIONS_FILENAME } from "../../http/webhook-session-store.js";
import { registerTaskTools } from "../../tools/tasks/index.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { SessionStore } from "../../session/index.js";
import { TelegramChannel } from "../../channels/telegram/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { AgentRuntime } from "../runtime-contract.js";

export function createRuntimeTaskStores(args: {
  config: Pick<AtomicAgentConfig, "paths" | "tasks">;
  logger: StructuredLogger;
}): { taskStore: TaskStore; webhookSessionStore: WebhookSessionStore } {
  const { config, logger } = args;
  const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const webhookSessionStore = new WebhookSessionStore(
    resolve(config.paths.stateDir, WEBHOOK_SESSIONS_FILENAME),
  );
  if (taskStore.runOwnersUnavailable !== null) {
    logger.warn("task runs will not record their process; boot recovery falls back to age", {
      reason: taskStore.runOwnersUnavailable,
    });
  }
  // Recover claims from a stopped process before a scheduler can see the queue;
  // leave another live process's claims alone. A recovery failure cannot block boot.
  try {
    const recoveredTasks = taskStore.recoverInterrupted({
      staleAfterMs: config.tasks.staleAfterMs,
    });
    if (recoveredTasks.length > 0) {
      logger.info("tasks left running by a stopped agent put back to pending", {
        count: recoveredTasks.length,
        taskIds: recoveredTasks.join(","),
      });
    }
  } catch (err) {
    logger.warn("could not recover tasks left running; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { taskStore, webhookSessionStore };
}

export function createRuntimeTaskRunner(args: {
  config: Pick<AtomicAgentConfig, "agent" | "tasks" | "paths" | "statusSnapshot">;
  taskStore: TaskStore;
  runTurn: TaskRunnerRuntime["runTurn"];
  sessionStore: Pick<SessionStore, "load" | "save" | "readTurnProgress" | "clearTurnProgress">
    & Partial<Pick<SessionStore, "isIncognito">>;
  createSession: AgentRuntime["createSession"];
  toolRegistry: ToolRegistry;
  resolveTelegram: () => TelegramChannel | null;
  logger: StructuredLogger;
  metrics: AgentMetrics;
  /** The live approval level, so a task started under another is left alone (ATO-1324). */
  approvalLevel?: () => number;
}): TaskRunner {
  const { config, taskStore, runTurn, sessionStore, createSession, toolRegistry, resolveTelegram, logger, metrics } = args;
  const taskRunner = new TaskRunner({
    store: taskStore,
    runtime: { runTurn },
    sessionLoader: sessionStore,
    sessionFactory: {
      create: (input) => createSession(input ?? {}),
      save: (state) => sessionStore.save(state),
    },
    defaultMaxSteps: config.agent.maxSteps,
    budgetedMaxSteps: config.agent.task.maxSteps,
    backoff: {
      initialMs: config.tasks.backoffInitialMs,
      maxMs: config.tasks.backoffMaxMs,
    },
    enabled: config.tasks.enabled,
    runOnCreate: config.tasks.runOnCreate,
    minIntervalMs: config.tasks.minIntervalMs,
    // Telegram is the only `TaskNotifyTarget` today, so the runner's
    // single sink IS the Telegram route (a second target would turn
    // this into a per-target dispatch). The channel is constructed
    // after the runner — it needs the finished runtime object — so the
    // sink resolves the same live reference the shutdown path uses,
    // assigned further below, at delivery time. A report that fires in
    // the window before that assignment (a due task on an early
    // scheduler tick while bootstrap is still, e.g., awaiting MCP
    // connects) is warn-logged and dropped, never lost silently; skips
    // never affect the task's own status, and the runner isolates sink
    // rejections. Skip-path logging is pinned by the sink's own unit
    // tests in telegram-channel.test.ts.
    reportSink: createTaskReportSink({ config, resolveTelegram, logger }),
    // Auto status snapshots of long reporting runs (ATO-965): one edited
    // Telegram message per task, silent inside quiet hours. Same late
    // channel resolution as the report sink.
    snapshotSink: TelegramChannel.buildTaskSnapshotSink({
      resolveChannel: resolveTelegram,
      quietHours: parseQuietHours(config.tasks.report?.quietHours ?? undefined),
    }),
    snapshotCadence: config.statusSnapshot ?? null,
    logger,
    metrics,
    ...(args.approvalLevel ? { approvalLevel: args.approvalLevel } : {}),
    // Continue a run a crash, a kill or a restart cut off from its
    // session's checkpoint (ATO-1109).
    resume: {
      enabled: config.agent.task.resumeInterrupted,
      maxResumes: config.agent.task.maxResumes,
      progress: {
        read: (sessionId) => sessionStore.readTurnProgress(sessionId),
        clear: (sessionId) => sessionStore.clearTurnProgress(sessionId),
      },
    },
  });

  registerTaskTools(toolRegistry, {
    taskStore,
    taskRunner,
    createSession,
    agentToolsEnabled: config.tasks.enabled && config.tasks.agentToolsEnabled,
    defaultMaxAttempts: config.tasks.maxAttempts,
    defaultListLimit: 20,
    // ATO-586: an incognito chat cannot schedule tasks.
    ...(sessionStore.isIncognito
      ? { isIncognitoSession: (sessionId: string) => sessionStore.isIncognito!(sessionId) }
      : {}),
  });

  return taskRunner;
}

/**
 * The Telegram report route, wrapped in morning delivery when
 * `tasks.report.quietHours` is set: reports finishing inside the window
 * are held in tasks.sqlite and sent as one digest when it ends (see
 * `TaskReportHold`). Off by default; a malformed window is warned
 * about and treated as off rather than holding reports forever.
 */
function createTaskReportSink(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "paths">;
  resolveTelegram: () => TelegramChannel | null;
  logger: StructuredLogger;
}): TaskReportSink {
  const { config, resolveTelegram, logger } = args;
  const direct = TelegramChannel.buildTaskReportSink({
    resolveChannel: resolveTelegram,
    logger,
  });
  const raw = config.tasks.report?.quietHours ?? null;
  if (raw === null) return direct;
  const quietHours = parseQuietHours(raw);
  if (quietHours === null) {
    logger.warn("task report quiet hours ignored: expected HH:MM-HH:MM", {
      value: raw,
    });
    return direct;
  }
  try {
    const hold = new TaskReportHold({
      quietHours,
      store: new SqliteHeldReportStore({ dbFile: config.paths.tasksDbFile }),
      deliverNow: direct,
      deliverDigest: TelegramChannel.buildTaskReportDigestSender({
        resolveChannel: resolveTelegram,
      }),
      logger,
    });
    hold.start();
    return hold.sink;
  } catch (err) {
    logger.warn("task report quiet hours unavailable; reports go out at once", {
      error: err instanceof Error ? err.message : String(err),
    });
    return direct;
  }
}

export function createRuntimeScheduler(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "paths">;
  taskRunner: TaskRunner;
  logger: StructuredLogger;
  metrics: AgentMetrics;
  /**
   * The live Telegram channel, resolved per tick (it is constructed
   * after the scheduler). Absent or `null`: Telegram is not wanted here.
   */
  resolveTelegram?: () => Pick<TelegramChannel, "hasToken" | "state"> | null;
}): Scheduler | null {
  const { config, taskRunner, logger, metrics, resolveTelegram } = args;
  if (!config.tasks.enabled || !config.tasks.schedulerEnabled) return null;
  // ATO-416: the desktop's `atag serve` and the TUI can share this state
  // dir, each with a scheduler. Only one drains due tasks — the Telegram
  // owner when this process wants Telegram, else the holder of
  // `scheduler.lock` (see `scheduler-leadership.ts`).
  const leadership = createSchedulerLeadership({
    stateDir: config.paths.stateDir,
    telegramWanted: () => {
      const channel = resolveTelegram?.() ?? null;
      return channel !== null && channel.hasToken() && channel.state() !== "disabled";
    },
  });
  return new Scheduler({
    taskRunner,
    tickMs: config.tasks.schedulerTickMs,
    batch: config.tasks.schedulerBatch,
    logger,
    metrics,
    leadership,
  });
}
