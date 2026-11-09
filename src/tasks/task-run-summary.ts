import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

import {
  clip,
  readApproval,
  readCommand,
  readFileChanges,
  type ApprovalObservation,
  type FileChangeKind,
} from "./task-run-summary-tools.js";

/**
 * Deterministic summary of one task run (ATO-964), collected by the
 * harness from the turn's own events, not written by the model: files
 * changed with line counts, commands with exit codes, test outcomes,
 * errors, approvals that stopped a call, open checklist items and the
 * questions the final reply asked. The model's reply stays as the short
 * "in words" part next to it.
 *
 * The collector is fed through the same `eventHook` the runner already
 * passes to `runTurn`; it keeps bounded state (every list is capped and
 * counts what it dropped) and is safe to snapshot at any time, which is
 * what the live status (ATO-965) reads.
 */

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  added: number;
  removed: number;
  approximate: boolean;
  /** How many writes/edits the run made to this path. */
  writes: number;
}

export interface CommandRun {
  command: string;
  /** Outcome of the LAST run of this command line. */
  exitCode: number | null;
  timedOut: boolean;
  test: boolean;
  /** How many times the run executed this exact command line. */
  runs: number;
}

export interface TaskRunSummary {
  /** The final reply (or `finish` summary); `null` when none came. */
  replyText: string | null;
  files: FileChange[];
  filesOmitted: number;
  commands: CommandRun[];
  commandsOmitted: number;
  errors: string[];
  errorsOmitted: number;
  approvals: ApprovalObservation[];
  /** Unchecked `- [ ]` items from the latest text that had a checklist. */
  openItems: string[];
  /** Lines of the final reply that ask the person something. */
  questions: string[];
  /** The provider said the account cannot pay for the next request. */
  creditExhausted: boolean;
  /** Steps finished so far (`step_finished` events). */
  steps: number;
  /**
   * The last finished step for live status, built from tool names and
   * ok/failed only (`describeStepTools`), e.g. `os.fs.read ok,
   * os.shell.run failed`. Never `step_finished.summary`: that is the tail
   * of raw tool output (file contents, a key) and `/status` goes to
   * Telegram, whose history outlives the session (ATO-1293).
   */
  lastStep: string | null;
}

/** A running task as `TaskRunner.liveStatus` reports it (ATO-965). */
export interface TaskLiveStatus {
  taskId: string;
  userMessage: string;
  startedAt: number;
  summary: TaskRunSummary;
}

export const SUMMARY_MAX_FILES = 100;
export const SUMMARY_MAX_COMMANDS = 50;
export const SUMMARY_MAX_ERRORS = 20;
export const SUMMARY_MAX_APPROVALS = 20;
export const SUMMARY_MAX_OPEN_ITEMS = 20;
export const SUMMARY_MAX_QUESTIONS = 3;
const LINE_MAX_CHARS = 200;
/** Tools named in `lastStep` before the rest is counted as "+N more". */
export const LAST_STEP_MAX_TOOLS = 4;

export interface TaskRunSummaryCollector {
  /** Install as (or call from) the turn's `eventHook`. */
  onEvent(event: AgentLoopEvent): void;
  /** A copy of what has been collected so far. */
  snapshot(): TaskRunSummary;
}

export function createTaskRunSummaryCollector(): TaskRunSummaryCollector {
  let replyText: string | null = null;
  let checklistSource: string | null = null;
  const files = new Map<string, FileChange>();
  let filesOmitted = 0;
  const commands = new Map<string, CommandRun>();
  let commandsOmitted = 0;
  const errors: string[] = [];
  let errorsOmitted = 0;
  const approvals: ApprovalObservation[] = [];
  let creditExhausted = false;
  let steps = 0;
  let lastStep: string | null = null;
  let stepTools: StepTool[] = [];

  const pushError = (text: string): void => {
    if (errors.length < SUMMARY_MAX_ERRORS) errors.push(clip(text, LINE_MAX_CHARS));
    else errorsOmitted += 1;
  };

  const noteText = (text: string, final: boolean): void => {
    if (final) replyText = text;
    if (/^\s*[-*]\s+\[[ xX]\]\s+/m.test(text)) checklistSource = text;
  };

  const onToolResult = (result: CompressedToolResult): void => {
    stepTools.push({ tool: result.tool, ok: result.status === "ok" });
    if (result.tool === "finish" && result.status === "ok") {
      // `details.summary` is the uncompressed argument; the compressed
      // `summary` is the fallback (same rule the runner always used).
      const full = result.details?.summary;
      noteText(typeof full === "string" && full.length > 0 ? full : result.summary, true);
      return;
    }
    for (const change of readFileChanges(result)) {
      const prior = files.get(change.path);
      if (prior) {
        prior.added += change.added;
        prior.removed += change.removed;
        prior.approximate ||= change.approximate;
        prior.writes += 1;
        if (prior.kind !== "created") prior.kind = change.kind;
      } else if (files.size < SUMMARY_MAX_FILES) {
        files.set(change.path, { ...change, writes: 1 });
      } else {
        filesOmitted += 1;
      }
    }
    const approval = readApproval(result);
    if (approval) {
      if (approvals.length < SUMMARY_MAX_APPROVALS) approvals.push(approval);
      return;
    }
    const command = readCommand(result);
    if (command) {
      const prior = commands.get(command.command);
      if (prior) {
        prior.exitCode = command.exitCode;
        prior.timedOut = command.timedOut;
        prior.runs += 1;
      } else if (commands.size < SUMMARY_MAX_COMMANDS) {
        commands.set(command.command, { ...command, runs: 1 });
      } else {
        commandsOmitted += 1;
      }
      return;
    }
    if (result.status === "error") {
      pushError(`${result.tool}: ${firstLine(result.summary)}`);
    }
  };

  return {
    onEvent(event) {
      switch (event.type) {
        case "step_started":
          stepTools = [];
          return;
        case "step_finished":
          steps += 1;
          lastStep = clip(describeStepTools(stepTools), LINE_MAX_CHARS);
          stepTools = [];
          return;
        case "credit_exhausted":
          creditExhausted = true;
          return;
        case "loop_failed":
          pushError(`turn failed [${event.category}]: ${event.error.message}`);
          return;
        case "llm_event": {
          const inner = event.event;
          if (inner.type === "assistant_reply") {
            // A progress note is not the result; the reply that ends
            // the turn follows it. Its checklist still counts.
            noteText(inner.text, inner.progressNote !== true);
          } else if (inner.type === "tool_call_executed") {
            onToolResult(inner.result);
          } else if (inner.type === "step_error") {
            pushError(`step error [${inner.category}]: ${inner.error.message}`);
          }
          return;
        }
        default:
          return;
      }
    },
    snapshot() {
      return {
        replyText,
        files: [...files.values()].map((f) => ({ ...f })),
        filesOmitted,
        commands: [...commands.values()].map((c) => ({ ...c })),
        commandsOmitted,
        errors: [...errors],
        errorsOmitted,
        approvals: approvals.map((a) => ({ ...a })),
        openItems: openChecklistItems(checklistSource),
        questions: questionsIn(replyText),
        creditExhausted,
        steps,
        lastStep,
      };
    },
  };
}

/** Unchecked `- [ ]` / `* [ ]` items, in order, capped. */
export function openChecklistItems(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
    if (!m) continue;
    out.push(clip(m[1]!, LINE_MAX_CHARS));
    if (out.length >= SUMMARY_MAX_OPEN_ITEMS) break;
  }
  return out;
}

/** Lines of the reply that end with a question mark, capped. */
export function questionsIn(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*>]|\d+[.)])\s*/, "").trim();
    if (!line.endsWith("?")) continue;
    out.push(clip(line, LINE_MAX_CHARS));
    if (out.length >= SUMMARY_MAX_QUESTIONS) break;
  }
  return out;
}

interface StepTool {
  tool: string;
  ok: boolean;
}

/**
 * One line for a finished step from stable identifiers only: each tool's
 * registry name and ok/failed, in call order, the tail counted. A step
 * with no tool calls reads "no tool calls".
 */
export function describeStepTools(tools: readonly StepTool[]): string {
  if (tools.length === 0) return "no tool calls";
  const shown = tools
    .slice(0, LAST_STEP_MAX_TOOLS)
    .map((t) => `${t.tool} ${t.ok ? "ok" : "failed"}`);
  const more = tools.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ?? "(no detail)";
}
