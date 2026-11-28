import { homedir } from "node:os";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { TaskRunner } from "../../tasks/index.js";
import {
  chokidarWatcherFactory,
  createFileTriggerClaims,
  FileTriggerManager,
  nodeFileTriggerFs,
  realFileTriggerClock,
  type FileTriggerFire,
} from "../../scheduler/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * File and log-line triggers (ATO-441). Watchers run only in the
 * scheduler leader (started and stopped through `onLeadershipChange`),
 * and each hit files a task the way a webhook hit does: the trigger
 * never calls `runTurn` itself. `null` when none are configured.
 *
 * Each hit first re-asks leadership (`confirmLeader`, the scheduler's
 * `confirmLeadership`) and takes a claim under the state dir, so a hit
 * seen by both processes around a hand-over files one task (ATO-2508).
 */
export function createRuntimeFileTriggers(args: {
  config: Pick<AtomicAgentConfig, "tasks" | "paths" | "fileTriggers">;
  taskRunner: Pick<TaskRunner, "create">;
  logger: StructuredLogger;
  confirmLeader: () => boolean;
}): FileTriggerManager | null {
  const { config, taskRunner, logger, confirmLeader } = args;
  const definitions = config.fileTriggers ?? {};
  if (Object.keys(definitions).length === 0) return null;
  return new FileTriggerManager({
    definitions,
    factory: chokidarWatcherFactory,
    fs: nodeFileTriggerFs,
    clock: realFileTriggerClock,
    homeDir: homedir(),
    logger,
    confirmLeader,
    claims: createFileTriggerClaims({ stateDir: config.paths.stateDir }),
    fire: (task: FileTriggerFire) => {
      try {
        const created = taskRunner.create({
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          userMessage: task.userMessage,
          origin: "scheduler",
          triggerSource: "file",
          maxAttempts: config.tasks.maxAttempts,
          maxSteps: null,
        });
        logger.info("file trigger filed a task", { trigger: task.trigger, taskId: created.id });
      } catch (err) {
        logger.warn("file trigger could not file a task", {
          trigger: task.trigger,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
}
