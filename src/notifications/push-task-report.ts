import type { PushNotifyConfig } from "../config/index.js";
import type { TaskReport, TaskReportSink } from "../tasks/index.js";
import { sendPush } from "./ntfy-client.js";
import { formatTaskPush } from "./push-messages.js";

/**
 * Task reports for `notify: "push"` (ATO-1129): the end of a durable
 * task — `task create --notify push`, `overnight --notify push` — as one
 * ntfy message. The runner calls the sink fire-and-forget; a push that
 * cannot be sent is a warn line, never a change to the task.
 */
export function createPushTaskReportSink(args: {
  /** Read at delivery time, so a later `push on` in this process counts. */
  readPush: () => PushNotifyConfig;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): TaskReportSink {
  return async (report: TaskReport) => {
    const result = await sendPush({
      push: args.readPush(),
      message: formatTaskPush(report),
      ...(args.env ? { env: args.env } : {}),
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
    if (result.outcome !== "sent") {
      args.logger?.warn("task push report not sent", {
        taskId: report.taskId,
        outcome: result.outcome,
        reason: result.reason,
      });
    }
  };
}
