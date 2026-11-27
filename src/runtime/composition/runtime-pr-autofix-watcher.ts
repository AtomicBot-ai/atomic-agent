import type { AtomicAgentConfig } from "../../config/index.js";
import { GithubApi, PrAutofixWatcher, resolveGithubToken } from "../../github/index.js";
import { isOfflineNetwork } from "../../llm/offline-network.js";
import type { SchedulerSidecar } from "../../scheduler/index.js";
import type { TaskRunner, TaskStore } from "../../tasks/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * The PR autofix watcher (ATO-2516) as a scheduler sidecar, so only the
 * process that leads the scheduler polls GitHub. Always built while
 * tasks are on: whether anything is watched is read from
 * `<stateDir>/pr-autofix/state.json` on every scan (empty by default,
 * so the default costs one small file read a minute and no request).
 * A round goes in through `TaskRunner.create` like a mail or file
 * trigger hit, one attempt per round: the next poll is the retry.
 */
export function createRuntimePrAutofixWatcher(args: {
  config: Pick<AtomicAgentConfig, "paths" | "tasks">;
  taskRunner: Pick<TaskRunner, "create">;
  taskStore: Pick<TaskStore, "get">;
  logger: StructuredLogger;
  /** Test seam; production reads the token and the offline switch per tick. */
  client?: () => GithubApi | null;
}): SchedulerSidecar | null {
  const { config, taskRunner, taskStore, logger } = args;
  if (!config.tasks.enabled) return null;
  const client =
    args.client ??
    (() => {
      if (isOfflineNetwork()) return null;
      const token = resolveGithubToken();
      return token ? new GithubApi({ token }) : null;
    });
  const watcher = new PrAutofixWatcher({
    stateDir: () => config.paths.stateDir,
    client,
    createTask: ({ sessionId, userMessage, notify }) =>
      taskRunner.create({
        ...(sessionId ? { sessionId } : {}),
        userMessage,
        origin: "scheduler",
        triggerSource: "scheduler",
        maxAttempts: 1,
        maxSteps: null,
        ...(notify ? { notify } : {}),
      }),
    taskStatus: (id) => taskStore.get(id)?.status ?? null,
    logger,
  });
  return { tick: (now, signal) => watcher.tick(now, signal) };
}
