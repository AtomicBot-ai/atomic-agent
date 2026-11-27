import type { SessionStore } from "../../session/index.js";
import type { TaskRunner } from "../../tasks/index.js";
import type { MonitorWake, ShellJobRegistry } from "../../tools/os/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * The runtime's path for a monitor notice (ATO-2436), used when no
 * frontend that shows the session took it:
 *
 *  1. a turn is running on the session: steer it, so the agent reads
 *     the notice at its next step;
 *  2. otherwise, with tasks on: file a one-shot task for the session,
 *     the path heartbeats and file triggers take (ATO-454, ATO-441).
 *     The task runner hands it to `runTurn`, so it waits in the
 *     session's `TurnController` FIFO behind any turn that starts
 *     meanwhile and never runs beside one. Nothing here calls
 *     `executeTurn`, so the sidecar's already-held lock is never
 *     entered again from inside.
 *
 * A session the store does not know (a fusion worker, a chat never
 * saved) gets no task: there would be nothing to run it in. `false`
 * leaves the lines with the monitor, which offers them again later.
 */
export function installShellMonitorWake(args: {
  shellJobs: Pick<ShellJobRegistry, "wake">;
  steer(sessionId: string, text: string): boolean;
  taskRunner: Pick<TaskRunner, "create">;
  sessionStore: Pick<SessionStore, "load">;
  tasksEnabled: boolean;
  logger: StructuredLogger;
}): void {
  const { shellJobs, steer, taskRunner, sessionStore, tasksEnabled, logger } = args;
  shellJobs.wake.setFallback((wake: MonitorWake) => {
    if (steer(wake.sessionId, wake.text)) return true;
    if (!tasksEnabled) return false;
    if (sessionStore.load(wake.sessionId) === null) return false;
    try {
      const task = taskRunner.create({
        sessionId: wake.sessionId,
        userMessage: wake.text,
        origin: "agent",
        triggerSource: "agent",
        // One try: a notice that could not run is not worth retrying
        // into a conversation that moved on; the monitor sends the next.
        maxAttempts: 1,
        maxSteps: null,
      });
      logger.info("shell monitor woke the session", {
        sessionId: wake.sessionId,
        jobId: wake.jobId,
        taskId: task.id,
      });
      return true;
    } catch (err) {
      logger.warn("shell monitor could not wake the session", {
        sessionId: wake.sessionId,
        jobId: wake.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  });
}
