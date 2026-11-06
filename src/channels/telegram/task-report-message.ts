import {
  buildTaskReportCard,
  type TaskReport,
  type TaskReportStatus,
} from "../../tasks/index.js";

import {
  fitMessage,
  formatDuration,
  formatSpend,
  oneLinePreview,
  TASK_MESSAGE_MAX_CHARS,
  truncateWithMarker,
} from "./task-report-format.js";

export { TASK_REPORT_TRUNCATION_MARKER } from "./task-report-format.js";

/**
 * Renders a `TaskReport` into the plain-text DM posted to the paired
 * owner when a scheduled task reaches a terminal status, and several
 * held reports into one morning digest.
 *
 * Layout (ATO-964): header, a meta line (attempts, duration, steps,
 * stop cause, spend when known), the model's reply as the short "in
 * words" part, then three sections built by the harness from what the
 * run actually did: Done, Failed, Needs you. Everything fits one
 * outbound chunk; whatever is cut says so.
 *
 * The whole message is **channel infrastructure**, so it always sends
 * as plain text — never `parse_mode: "HTML"` — per the ../README.md
 * §"Telegram remote-control channel" carve-out (formatted text ==
 * agent content, plain text == infrastructure). The reply excerpt is
 * agent content embedded in an infra envelope and degrades to plain
 * text with it.
 *
 * Privacy note: everything rendered here (the task prompt preview,
 * file paths, command lines and the result / error excerpt) leaves the
 * machine through the Telegram Bot API. Reports only exist for tasks
 * that explicitly opted in via `notify: "telegram"`.
 */

/** Cap on the "in words" reply excerpt. */
export const TASK_REPORT_RESULT_MAX_CHARS = 1200;

/** The excerpt never shrinks below this to make room for sections. */
const RESULT_MIN_CHARS = 200;

/** Cap on the error excerpt (the row's `lastError` is already capped at 2000). */
export const TASK_REPORT_ERROR_MAX_CHARS = 500;

/** Cap on the single-line task-prompt preview in the header. */
export const TASK_REPORT_PROMPT_PREVIEW_CHARS = 120;

/** Below this many characters per report a digest lists the rest by id. */
const DIGEST_MIN_PER_REPORT = 450;

const STATUS_PRESENTATION: Record<
  TaskReportStatus,
  { icon: string; label: string }
> = {
  completed: { icon: "✅", label: "completed" },
  failed: { icon: "❌", label: "failed" },
  blocked: { icon: "⛔", label: "blocked" },
};

export function formatTaskReportMessage(
  report: TaskReport,
  options: { maxChars?: number } = {},
): string {
  const { icon, label } = STATUS_PRESENTATION[report.status];
  const head = [
    `${icon} Scheduled task ${label}`,
    `Task: ${oneLinePreview(report.userMessage, TASK_REPORT_PROMPT_PREVIEW_CHARS)} (${scheduleLabel(
      report.scheduleKind,
    )} ${report.taskId})`,
    metaLine(report),
  ].join("\n");
  const errorLine =
    report.status === "completed"
      ? null
      : `Error [${report.errorCategory ?? "unknown"}]: ${truncateWithMarker(
          report.errorMessage ?? "(no error recorded)",
          TASK_REPORT_ERROR_MAX_CHARS,
        )}`;
  const reply = report.replyText;
  const text =
    report.status === "completed" || reply !== null
      ? {
          label: "In words:",
          body: reply ?? "(no reply)",
          max: TASK_REPORT_RESULT_MAX_CHARS,
          minText: RESULT_MIN_CHARS,
        }
      : null;
  const hasRun = report.summary != null || report.stopCause != null;
  const card = hasRun
    ? buildTaskReportCard({
        status: report.status,
        summary: report.summary ?? null,
        stopCause: report.stopCause ?? null,
      })
    : null;
  if (card === null && errorLine !== null) {
    // No run facts (the task never reached a turn): the error is the report.
    return fitMessage({
      head: `${head}\n${errorLine}`,
      text,
      card: null,
      maxChars: options.maxChars ?? TASK_MESSAGE_MAX_CHARS,
    });
  }
  return fitMessage({
    head,
    text,
    card,
    extraFailed: errorLine === null ? [] : [errorLine],
    maxChars: options.maxChars ?? TASK_MESSAGE_MAX_CHARS,
  });
}

/**
 * Several reports held through quiet hours, as one message. Each
 * report keeps its own sections at a smaller budget; when even that
 * does not fit, the reports past the budget are named by id so nothing
 * disappears without a trace.
 */
export function formatTaskReportDigest(reports: readonly TaskReport[]): string {
  if (reports.length === 1) return formatTaskReportMessage(reports[0]!);
  const counts = { completed: 0, failed: 0, blocked: 0 };
  for (const r of reports) counts[r.status] += 1;
  const header = [
    `Morning report: ${reports.length} tasks finished during quiet hours`,
    `✅ ${counts.completed} completed · ❌ ${counts.failed} failed · ⛔ ${counts.blocked} blocked`,
  ].join("\n");
  const separator = "\n\n― ― ―\n\n";
  const tailReserve = 200; // room for the "not shown" line
  const room = TASK_MESSAGE_MAX_CHARS - header.length - tailReserve;
  const perReport = Math.floor(room / reports.length) - separator.length;
  const shown =
    perReport >= DIGEST_MIN_PER_REPORT
      ? reports.length
      : Math.max(1, Math.floor(room / (DIGEST_MIN_PER_REPORT + separator.length)));
  const budget = Math.floor(room / shown) - separator.length;
  const blocks = reports
    .slice(0, shown)
    .map((r) => formatTaskReportMessage(r, { maxChars: budget }));
  const parts = [header, ...blocks];
  let out = parts.join(separator);
  const hidden = reports.slice(shown);
  if (hidden.length > 0) {
    const ids = hidden.map((r) => r.taskId).join(", ");
    out += `${separator}${truncateWithMarker(
      `… ${hidden.length} more reports not shown: ${ids}`,
      tailReserve - 20,
    )}`;
  }
  return out;
}

function metaLine(report: TaskReport): string {
  const parts = [`Attempt ${report.attempts}/${report.maxAttempts}`];
  if (report.durationMs !== null) {
    parts.push(`took ${formatDuration(report.durationMs)}`);
  }
  if (report.stepCount != null) parts.push(`${report.stepCount} steps`);
  if (report.stopCause != null) parts.push(`stop: ${report.stopCause}`);
  if (report.spendUsd != null) parts.push(`spend ~${formatSpend(report.spendUsd)}`);
  return parts.join(" · ");
}

function scheduleLabel(kind: TaskReport["scheduleKind"]): string {
  if (kind === "cron") return "cron";
  if (kind === "interval") return "interval";
  // `at` and eager (null-schedule) tasks are both single firings.
  return "one-shot";
}
