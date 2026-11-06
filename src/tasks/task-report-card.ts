import type { TaskReportStatus } from "./task-report.js";
import type { CommandRun, FileChange, TaskRunSummary } from "./task-run-summary.js";

/**
 * The three sections of a task report card (ATO-964): what got done,
 * what failed, and what needs the person. Channel-agnostic plain lines;
 * a channel adds its own envelope, caps and truncation markers. The
 * same builder serves the final report and the live status snapshot
 * (ATO-965), so the two never disagree about what a run did.
 *
 * Every line comes from the harness's own record of the run
 * (`TaskRunSummary`) and the turn's stop cause, never from the model's
 * prose, except the questions, which are quoted from its final reply.
 */
export interface TaskReportCard {
  done: string[];
  failed: string[];
  needsYou: string[];
}

export interface TaskReportCardInput {
  /** `running` for a live snapshot. */
  status: TaskReportStatus | "running";
  summary: TaskRunSummary | null;
  stopCause?: string | null;
}

/** Plain wording per ceiling; an unknown cause is named as is. */
const STOP_CAUSE_LINES: Record<string, string> = {
  step_ceiling: "Stopped at the step limit. The work may not be finished.",
  time_ceiling: "Stopped at the time limit. The work may not be finished.",
  cost_ceiling: "Stopped at the budget limit. The work may not be finished.",
  no_progress: "Stopped because the run was not making progress.",
  credit_exhausted: "The provider account ran out of credit. Top up to resume.",
};

export function stopCauseLine(cause: string): string {
  return STOP_CAUSE_LINES[cause] ?? `Stopped early (${cause}).`;
}

export function buildTaskReportCard(input: TaskReportCardInput): TaskReportCard {
  const { summary } = input;
  const done: string[] = [];
  const failed: string[] = [];
  const needsYou: string[] = [];

  if (summary) {
    for (const file of summary.files) done.push(fileLine(file));
    if (summary.filesOmitted > 0) {
      done.push(`… ${summary.filesOmitted} more file changes not listed`);
    }
    for (const command of summary.commands) {
      if (commandSucceeded(command)) done.push(commandLine(command));
      else failed.push(commandLine(command));
    }
    if (summary.commandsOmitted > 0) {
      done.push(`… ${summary.commandsOmitted} more commands not listed`);
    }
    failed.push(...summary.errors);
    if (summary.errorsOmitted > 0) {
      failed.push(`… ${summary.errorsOmitted} more errors not listed`);
    }
    for (const approval of summary.approvals) {
      needsYou.push(
        approval.byUser
          ? `You declined ${approval.tool}.`
          : `${approval.tool} needed an approval nobody gave.`,
      );
    }
  }

  if (input.status === "blocked") {
    needsYou.push("The task is blocked and will not retry on its own.");
  }
  const cause =
    input.stopCause ?? (summary?.creditExhausted ? "credit_exhausted" : null);
  if (cause !== null) needsYou.push(stopCauseLine(cause));
  if (summary) {
    for (const question of summary.questions) needsYou.push(`Asked: ${question}`);
    for (const item of summary.openItems) needsYou.push(`Open: ${item}`);
  }
  return { done, failed, needsYou };
}

function commandSucceeded(command: CommandRun): boolean {
  return command.exitCode === 0 && !command.timedOut;
}

function commandLine(command: CommandRun): string {
  const times = command.runs > 1 ? ` (ran ${command.runs}x, last shown)` : "";
  const exit = command.timedOut
    ? "timed out"
    : command.exitCode === null
      ? "killed"
      : `exit ${command.exitCode}`;
  if (command.test) {
    const verdict = commandSucceeded(command) ? "tests passed" : `tests failed, ${exit}`;
    return `$ ${command.command} : ${verdict}${times}`;
  }
  return `$ ${command.command} : ${exit}${times}`;
}

function fileLine(file: FileChange): string {
  const approx = file.approximate ? " (approx.)" : "";
  const counts = `+${file.added} -${file.removed}${approx}`;
  switch (file.kind) {
    case "created":
      return `created ${file.path} ${counts}`;
    case "appended":
      return `appended to ${file.path} ${counts}`;
    case "rewritten":
      return `rewrote ${file.path} ${counts}`;
    default:
      return `edited ${file.path} ${counts}`;
  }
}
