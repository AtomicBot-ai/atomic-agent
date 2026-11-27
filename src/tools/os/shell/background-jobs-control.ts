import type { ShellJobRegistry } from "./shell-jobs.js";
import type { MonitorWakeHandler } from "./shell-monitor-wake.js";

/**
 * What a frontend may do with a session's background shell jobs, on
 * `AgentRuntime.backgroundJobs` (ATO-2436). Narrow on purpose: the
 * registry itself stays the runtime's.
 */
export interface BackgroundJobsControl {
  /**
   * Take monitor notices for the sessions this frontend shows. The
   * handler answers `false` for any other session, which then goes the
   * runtime's way (steer, else a queued task). Returns its removal.
   */
  onMonitorWake(handler: MonitorWakeHandler): () => void;
}

export function createBackgroundJobsControl(
  registry: Pick<ShellJobRegistry, "wake">,
): BackgroundJobsControl {
  return {
    onMonitorWake: (handler) => registry.wake.addFrontend(handler),
  };
}
