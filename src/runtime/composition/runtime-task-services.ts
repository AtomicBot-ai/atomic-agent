import { resolve } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import { TaskStore, TaskRunner } from "../../tasks/index.js";
import type { TaskRunnerRuntime } from "../../tasks/task-runner.js";
import { Scheduler } from "../../scheduler/index.js";
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
  config: Pick<AtomicAgentConfig, "agent" | "tasks">;
  taskStore: TaskStore;
  runTurn: TaskRunnerRuntime["runTurn"];
  sessionStore: Pick<SessionStore, "load" | "save">;
  createSession: AgentRuntime["createSession"];
  toolRegistry: ToolRegistry;
  resolveTelegram: () => TelegramChannel | null;
  logger: StructuredLogger;
  metrics: AgentMetrics;
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
    reportSink: TelegramChannel.buildTaskReportSink({
      resolveChannel: resolveTelegram,
      logger,
    }),
    logger,
    metrics,
  });

  registerTaskTools(toolRegistry, {
    taskStore,
    taskRunner,
    createSession,
    agentToolsEnabled: config.tasks.enabled && config.tasks.agentToolsEnabled,
    defaultMaxAttempts: config.tasks.maxAttempts,
    defaultListLimit: 20,
  });

  return taskRunner;
}

export function createRuntimeScheduler(args: {
  config: Pick<AtomicAgentConfig, "tasks">;
  taskRunner: TaskRunner;
  logger: StructuredLogger;
  metrics: AgentMetrics;
}): Scheduler | null {
  const { config, taskRunner, logger, metrics } = args;
  const scheduler =
    config.tasks.enabled && config.tasks.schedulerEnabled
      ? new Scheduler({
          taskRunner,
          tickMs: config.tasks.schedulerTickMs,
          batch: config.tasks.schedulerBatch,
          logger,
          metrics,
        })
      : null;
  return scheduler;
}
