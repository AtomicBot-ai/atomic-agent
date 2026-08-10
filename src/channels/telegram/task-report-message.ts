import type { TaskReport, TaskReportStatus } from "../../tasks/index.js";

/**
 * Renders a `TaskReport` into the plain-text DM posted to the paired
 * owner when a scheduled task reaches a terminal status.
 *
 * The whole message is **channel infrastructure**, so it always sends
 * as plain text — never `parse_mode: "HTML"` — per the AGENTS.md
 * §"Telegram remote-control channel" carve-out (formatted text ==
 * agent content, plain text == infrastructure). The result excerpt is
 * agent content embedded in an infra envelope; formatting only the
 * excerpt would require splitting the message, so the envelope wins
 * and the excerpt degrades to plain text with it.
 *
 * Privacy note: everything rendered here (the task prompt preview and
 * the result / error excerpt) leaves the machine through the Telegram
 * Bot API. Reports only exist for tasks that explicitly opted in via
 * `notify: "telegram"`.
 */

/** Cap on the result excerpt. Keeps the report inside one 4096-char Telegram message. */
export const TASK_REPORT_RESULT_MAX_CHARS = 3000;

/** Cap on the error excerpt (the row's `lastError` is already capped at 2000). */
export const TASK_REPORT_ERROR_MAX_CHARS = 500;

/** Cap on the single-line task-prompt preview in the header. */
export const TASK_REPORT_PROMPT_PREVIEW_CHARS = 120;

/** Appended whenever an excerpt was cut, so truncation is never silent. */
export const TASK_REPORT_TRUNCATION_MARKER = "… [truncated]";

const STATUS_PRESENTATION: Record<
  TaskReportStatus,
  { icon: string; label: string }
> = {
  completed: { icon: "✅", label: "completed" },
  failed: { icon: "❌", label: "failed" },
  blocked: { icon: "⛔", label: "blocked" },
};

export function formatTaskReportMessage(report: TaskReport): string {
  const { icon, label } = STATUS_PRESENTATION[report.status];
  const lines: string[] = [
    `${icon} Scheduled task ${label}`,
    `Task: ${promptPreview(report.userMessage)} (${scheduleLabel(
      report.scheduleKind,
    )} ${report.taskId})`,
    metaLine(report),
  ];
  if (report.status === "completed") {
    lines.push(
      "",
      report.replyText === null
        ? "(no reply)"
        : truncateWithMarker(report.replyText, TASK_REPORT_RESULT_MAX_CHARS),
    );
  } else {
    const category = report.errorCategory ?? "unknown";
    const message = report.errorMessage ?? "(no error recorded)";
    lines.push(
      `Error [${category}]: ${truncateWithMarker(
        message,
        TASK_REPORT_ERROR_MAX_CHARS,
      )}`,
    );
  }
  return lines.join("\n");
}

function metaLine(report: TaskReport): string {
  const attempt = `Attempt ${report.attempts}/${report.maxAttempts}`;
  if (report.durationMs === null) return attempt;
  return `${attempt} · took ${formatDuration(report.durationMs)}`;
}

function scheduleLabel(kind: TaskReport["scheduleKind"]): string {
  if (kind === "cron") return "cron";
  if (kind === "interval") return "interval";
  // `at` and eager (null-schedule) tasks are both single firings.
  return "one-shot";
}

function promptPreview(userMessage: string): string {
  const flat = userMessage.replace(/\s+/g, " ").trim();
  if (flat.length <= TASK_REPORT_PROMPT_PREVIEW_CHARS) return flat;
  return `${flat.slice(0, TASK_REPORT_PROMPT_PREVIEW_CHARS - 1)}…`;
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${TASK_REPORT_TRUNCATION_MARKER}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
