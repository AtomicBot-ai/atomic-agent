/**
 * What `atomic-agent overnight` prints (ATO-1113): one compact line per
 * finished step, the final reply picked out of the event stream, and the
 * closing summary. Pure, so the wording is pinned by unit tests.
 */
import type { AgentLoopEvent } from "../agent/index.js";
import {
  describeChannelLockConflict,
  isChannelLockConflict,
} from "../channels/channel-lock-error.js";
import { formatUsd } from "../llm/provider/usage-cost.js";
import { stopCauseLine, type TaskRecord } from "../tasks/index.js";

const SUMMARY_MAX = 100;

export interface ProgressLineInput {
  stepIndex: number;
  summary: string;
  elapsedMs: number;
  /** This run's spend so far (`step_finished.spendUsd`). */
  spendUsd: number | undefined;
  /**
   * What the task had spent before this run started. The cap covers the
   * whole task, so a resumed or retried run shows the sum against it.
   */
  spentBeforeUsd?: number;
  /** Effective cap in dollars; 0 = none. */
  capUsd: number;
}

/** `[step 12 | 14m | $0.42 of $5.00] read src/app.ts` */
export function formatProgressLine(input: ProgressLineInput): string {
  const parts = [`step ${input.stepIndex + 1}`, formatElapsed(input.elapsedMs)];
  const before = input.spentBeforeUsd ?? 0;
  if (input.spendUsd !== undefined || input.capUsd > 0 || before > 0) {
    const spent = formatUsd(before + (input.spendUsd ?? 0));
    parts.push(input.capUsd > 0 ? `${spent} of ${formatUsd(input.capUsd)}` : spent);
  }
  const oneLine = input.summary.replace(/\s+/g, " ").trim();
  const summary =
    oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 3)}...` : oneLine;
  return `[${parts.join(" | ")}] ${summary}`.trimEnd();
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * The text that ends the turn, read the way the task runner reads it for
 * its Telegram report: an `assistant_reply` that is not a progress note,
 * or the summary of a successful `finish`. `undefined` = not a result.
 */
export function replyFromEvent(event: AgentLoopEvent): string | undefined {
  if (event.type !== "llm_event") return undefined;
  const step = event.event;
  if (step.type === "assistant_reply") {
    return step.progressNote === true ? undefined : step.text;
  }
  if (
    step.type === "tool_call_executed" &&
    step.result.tool === "finish" &&
    step.result.status === "ok"
  ) {
    const full = step.result.details?.summary;
    return typeof full === "string" && full.length > 0 ? full : step.result.summary;
  }
  return undefined;
}

export interface OvernightSummaryInput {
  task: TaskRecord;
  elapsedMs: number;
  capUsd: number;
  reply: string | null;
  deniedApprovals: number;
}

export function formatOvernightSummary(input: OvernightSummaryInput): string {
  const { task } = input;
  const spent = formatUsd(task.spentUsd ?? 0);
  const lines = [
    "",
    `overnight ${overnightOutcome(task)}: ${task.id}`,
    `  time:  ${formatElapsed(input.elapsedMs)}`,
    `  spent: ${input.capUsd > 0 ? `${spent} of ${formatUsd(input.capUsd)}` : spent} (estimate; local models count as $0)`,
  ];
  const cause = limitCause(task);
  if (cause !== null) lines.push(`  ${stopCauseLine(cause)}`);
  if (input.deniedApprovals > 0) {
    lines.push(
      `  denied ${input.deniedApprovals} action(s) that needed approval; rerun with --no-approval to allow them`,
    );
  }
  if (task.status === "pending") {
    lines.push(
      `  interrupted by the system; the task stays queued to resume (atomic-agent task show ${task.id})`,
    );
  }
  if (task.lastError && task.status !== "completed") {
    lines.push(`  error: ${task.lastError}`);
  }
  if (input.reply) {
    lines.push("", input.reply.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function formatDetachedNotice(taskId: string, logPath: string, dir: string): string {
  return [
    `overnight run started in the background: ${taskId}`,
    `  working in: ${dir}`,
    `  log:        ${logPath}`,
    `  check it:   atomic-agent task show ${taskId}`,
    `  stop it:    atomic-agent task cancel ${taskId}`,
    "",
  ].join("\n");
}

/**
 * The line `overnight --notify telegram` prints when its report never
 * left (ATO-1358). The report waits in this process's memory for the
 * channel, and this process is about to exit. The usual cause: the
 * desktop app or the TUI holds the Telegram connection (`telegram.lock`).
 */
export function formatTelegramUndelivered(lastError: string | null, taskId: string): string {
  let why: string;
  if (isChannelLockConflict(lastError)) {
    // "already running in another atomic-agent (pid 123)"
    const held = describeChannelLockConflict(lastError ?? "");
    why = `Telegram is ${held || "already running in another atomic-agent"} ` +
      "(the desktop app or the TUI), so this run could not use it";
  } else {
    why = lastError
      ? `the Telegram channel did not come up (${lastError})`
      : "the Telegram channel did not come up";
  }
  return (
    `  telegram report not sent: ${why}. ` +
    `The result is above and in \`atomic-agent task show ${taskId}\`.\n`
  );
}

/**
 * The store calls a run a ceiling ended `completed` and keeps the cause
 * beside it (ATO-1323). For the person or script reading the result
 * that is not "done": the work may be unfinished.
 */
type OutcomeFields = Pick<TaskRecord, "status" | "stopCause"> & Partial<Pick<TaskRecord, "lastError">>;

/**
 * The limit that ended the run, if one did: a ceiling the turn hit (or
 * the provider credit running out), or a resume the runner blocked
 * because earlier attempts had already used the budget or the time.
 */
function limitCause(task: OutcomeFields): string | null {
  if (task.status === "completed" && typeof task.stopCause === "string" && task.stopCause.length > 0) {
    return task.stopCause;
  }
  if (task.status === "blocked" && typeof task.lastError === "string") {
    if (task.lastError.startsWith("budget_spent:")) return "cost_ceiling";
    if (task.lastError.startsWith("time_spent:")) return "time_ceiling";
  }
  return null;
}

function stoppedByLimit(task: OutcomeFields): boolean {
  return limitCause(task) !== null;
}

/** `completed`, `stopped (cost_ceiling)`, `failed`, ... */
export function overnightOutcome(task: OutcomeFields): string {
  const cause = limitCause(task);
  return cause !== null ? `stopped (${cause})` : task.status;
}

/**
 * Exit code when a limit ended the run: the budget, the time, the steps,
 * no progress, or the provider credit running out.
 */
export const OVERNIGHT_STOPPED_EXIT_CODE = 2;

/**
 * 0 only when the agent finished on its own; 2 when a limit stopped it
 * (the run itself worked, the task may not be done); 1 otherwise.
 */
export function overnightExitCode(task: OutcomeFields): number {
  if (stoppedByLimit(task)) return OVERNIGHT_STOPPED_EXIT_CODE;
  return task.status === "completed" ? 0 : 1;
}
