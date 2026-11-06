import { buildTaskReportCard, type TaskLiveStatus } from "../../tasks/index.js";

import {
  fitMessage,
  formatDuration,
  oneLinePreview,
} from "./task-report-format.js";

/**
 * The live snapshot of running tasks that Telegram `/status` appends
 * (ATO-965): for each task this runner is running, elapsed time, steps,
 * the last step, and the same Done / Failed / Needs you sections the
 * final report will carry, built from the same collector. Plain text
 * (channel infrastructure), cut with markers to fit `maxChars`.
 */

const PROMPT_PREVIEW_CHARS = 80;
const LATEST_REPLY_MAX_CHARS = 300;

export function formatTaskLiveStatus(
  statuses: readonly TaskLiveStatus[],
  now: number,
  maxChars: number,
): string {
  if (statuses.length === 0) return "Running tasks: none.";
  const header = `Running tasks: ${statuses.length}`;
  const per = Math.floor((maxChars - header.length) / statuses.length) - 2;
  const blocks = statuses.map((status) => {
    const { summary } = status;
    const head = [
      `▶ ${oneLinePreview(status.userMessage, PROMPT_PREVIEW_CHARS)} (${status.taskId})`,
      `${formatDuration(Math.max(0, now - status.startedAt))} so far · ${summary.steps} steps`,
      ...(summary.lastStep ? [`Last step: ${summary.lastStep}`] : []),
    ].join("\n");
    return fitMessage({
      head,
      text:
        summary.replyText === null
          ? null
          : {
              label: "Latest reply:",
              body: summary.replyText,
              max: LATEST_REPLY_MAX_CHARS,
              minText: 80,
            },
      card: buildTaskReportCard({ status: "running", summary }),
      maxChars: Math.max(per, 200),
    });
  });
  return [header, ...blocks].join("\n\n");
}
