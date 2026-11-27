import { headOfCommand } from "./shell-job-calls.js";
import type { ShellJobRegistry, ShellJobState, ShellJobStopReason } from "./shell-jobs.js";
import type { MonitorWakeHandler } from "./shell-monitor-wake.js";

/**
 * What a frontend may do with a session's background shell jobs, on
 * `AgentRuntime.backgroundJobs` (ATO-2436, ATO-2437). Narrow on
 * purpose: the registry itself stays the runtime's.
 */
export interface BackgroundJobView {
  id: number;
  /** Head of the command line. */
  command: string;
  state: ShellJobState;
  keep: boolean;
  pid: number | null;
  /** Since the start; for a finished job, how long it ran. */
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  stopReason: ShellJobStopReason | null;
  /** The pattern of its active monitor, else `null`. */
  monitor: string | null;
}

export interface BackgroundJobsControl {
  /**
   * Take monitor notices for the sessions this frontend shows. The
   * handler answers `false` for any other session, which then goes the
   * runtime's way (steer, else a queued task). Returns its removal.
   */
  onMonitorWake(handler: MonitorWakeHandler): () => void;
  /** `sessionId`'s jobs, oldest first, finished ones until the agent collects them. */
  list(sessionId: string): BackgroundJobView[];
  /**
   * The person stops one job (`/stop <id>`, ATO-2437). The record stays,
   * so the agent's next `wait` reads that the user stopped it. `false`
   * when there is no such running job in that session.
   */
  stop(sessionId: string, id: number): boolean;
  /** `/stop`: every running job of the session; how many were stopped. */
  stopAll(sessionId: string): number;
}

export function createBackgroundJobsControl(
  registry: Pick<ShellJobRegistry, "wake" | "list" | "get" | "stop">,
): BackgroundJobsControl {
  return {
    onMonitorWake: (handler) => registry.wake.addFrontend(handler),
    list: (sessionId) =>
      registry.list(sessionId).map((record) => {
        const exit = record.job.exited();
        return {
          id: record.id,
          command: headOfCommand(record.facts.commandLine),
          state: record.state,
          keep: record.keep,
          pid: record.job.pid ?? null,
          elapsedMs: exit ? exit.durationMs : Date.now() - record.job.startedAt,
          exitCode: exit?.exitCode ?? null,
          signal: exit?.signal ?? null,
          stopReason: record.stopReason,
          monitor: record.monitor?.active === true ? record.monitor.until : null,
        };
      }),
    stop: (sessionId, id) => {
      const record = registry.get(sessionId, id);
      return record !== undefined && registry.stop(record, "user");
    },
    stopAll: (sessionId) =>
      registry
        .list(sessionId)
        .filter((record) => record.state === "running")
        .filter((record) => registry.stop(record, "user")).length,
  };
}
