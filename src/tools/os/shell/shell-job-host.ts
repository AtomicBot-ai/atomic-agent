import { isMaskableSecretValue } from "../../../error-reporting/secret-detector.js";
import type { CommandJob } from "../../../sandbox/command-job.js";
import { rememberResolvedSecret } from "../../../sandbox/resolved-secret-values.js";
import { readJobOutput, type JobOutputSlice } from "./job-output-tap.js";
import type { ShellJobRecord, ShellJobRegistry, ShellJobState } from "./shell-jobs.js";

/**
 * The person's side of the agent's kept `os.shell.run` jobs (ATO-2485),
 * for hosts that draw them (the desktop's terminal tab): list a session's
 * jobs, read one's output as it comes, type into an interactive one, stop
 * one. The job and its pseudo-terminal stay the core's (ATO-2277); a host
 * only attaches to it.
 *
 * What the person types goes straight to the job's stdin. It is not a
 * tool call: it is never written to the session, the transcript, the
 * trace or a log, and the model only learns of it through what the
 * program itself prints. A write marked `secret` (the host's Hide typing)
 * is also added to the values masked in every tool result and trace
 * (`resolved-secret-values.ts`), so a prompt that echoes it, or a script
 * that prints it, does not hand it to the model; only a value the
 * detector can mask (`isMaskableSecretValue`: 8 characters or more, not
 * a plain word) is, and {@link secretInputMasked} says which.
 * It does not pass the command guard either: the guard and approvals are
 * there to hold the model back, and this input is the person's own.
 *
 * Every call is addressed by session and job id, the same pair the model
 * uses; an id of another session is unknown here.
 */

/** Characters one write may carry: a pasted line or a password, not a file. */
export const SHELL_JOB_INPUT_MAX_CHARS = 8_192;

export interface ShellJobView {
  id: number;
  /** As the approval card and the tool result show it. */
  commandLine: string;
  cwd: string;
  state: ShellJobState;
  /** Started with `tty: true`: its stdin is open and takes the person's input. */
  interactive: boolean;
  /** The job can be told a new terminal size (a native pty backend; ATO-2484). */
  resizable: boolean;
  startedAt: number;
  exitCode: number | null;
  signal: string | null;
}

export interface ShellJobWriteOptions {
  /** The person typed it hidden (a password): mask it wherever the model reads. */
  secret?: boolean;
}

/** The value of a secret write: what was typed, without the Enter that sends it. */
export function secretInputValue(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/** Whether a secret write of `text` is masked in what the model reads. */
export function secretInputMasked(text: string): boolean {
  return isMaskableSecretValue(secretInputValue(text));
}

export type ShellJobWriteOutcome = "written" | "not_found" | "closed" | "too_long";
export type ShellJobResizeOutcome = "resized" | "not_found" | "not_supported";
export type ShellJobStopOutcome = "stopped" | "not_found" | "not_running";

export interface ShellJobHostControls {
  list(sessionId: string): ShellJobView[];
  read(sessionId: string, id: number, since: number): (JobOutputSlice & { job: ShellJobView }) | null;
  write(sessionId: string, id: number, text: string, eof?: boolean, options?: ShellJobWriteOptions): ShellJobWriteOutcome;
  resize(sessionId: string, id: number, cols: number, rows: number): ShellJobResizeOutcome;
  stop(sessionId: string, id: number): ShellJobStopOutcome;
}

/** A backend that can resize its terminal; the `script(1)` one cannot. */
type ResizableJob = CommandJob & { resize(cols: number, rows: number): boolean | void };

function isResizable(job: CommandJob): job is ResizableJob {
  return typeof (job as Partial<ResizableJob>).resize === "function";
}

/**
 * Whether stdin is open. Writing nothing is the probe `CommandJob` already
 * offers: it answers `false` for a job started without `keepStdinOpen`,
 * one that ended, or one whose stdin is gone, and puts no byte on the pipe.
 */
function takesInput(record: ShellJobRecord): boolean {
  return record.state === "running" && record.job.exited() === null && record.job.write("");
}

function viewOf(record: ShellJobRecord): ShellJobView {
  const exit = record.job.exited();
  return {
    id: record.id,
    commandLine: record.facts.commandLine,
    cwd: record.facts.cwd,
    state: record.state,
    interactive: takesInput(record),
    resizable: record.state === "running" && isResizable(record.job),
    startedAt: record.job.startedAt,
    exitCode: exit?.exitCode ?? null,
    signal: exit?.signal ?? null,
  };
}

export function createShellJobHostControls(
  registry: Pick<ShellJobRegistry, "get" | "list" | "stop">,
): ShellJobHostControls {
  return {
    list: (sessionId) => registry.list(sessionId).map(viewOf),
    read(sessionId, id, since) {
      const record = registry.get(sessionId, id);
      if (!record) return null;
      return { ...readJobOutput(record.job, since), job: viewOf(record) };
    },
    write(sessionId, id, text, eof = false, options = {}) {
      const record = registry.get(sessionId, id);
      if (!record) return "not_found";
      if (text.length > SHELL_JOB_INPUT_MAX_CHARS) return "too_long";
      if (!takesInput(record)) return "closed";
      // Before the write: the job may echo it at once.
      if (options.secret === true) rememberResolvedSecret(`typed into job ${id}`, secretInputValue(text));
      if (text.length > 0 && !record.job.write(text)) return "closed";
      if (eof) record.job.endInput();
      return "written";
    },
    resize(sessionId, id, cols, rows) {
      const record = registry.get(sessionId, id);
      if (!record) return "not_found";
      if (record.state !== "running" || !isResizable(record.job)) return "not_supported";
      // The native pty answers `false` when the terminal is already gone.
      return record.job.resize(cols, rows) === false ? "not_supported" : "resized";
    },
    stop(sessionId, id) {
      const record = registry.get(sessionId, id);
      if (!record) return "not_found";
      return registry.stop(record, "user") ? "stopped" : "not_running";
    },
  };
}
