import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import type {
  AgentLoopEvent,
  AgentLoopReason,
  RunTurnResult,
} from "../../agent/agent-loop.js";
import { FUSION_WORKER_APPROVAL_MARKER } from "./worker-tool-policy.js";

/**
 * What one delegated task produced, as the orchestrator sees it.
 *
 * A worker session is thrown away the moment its turn ends, so this
 * object is the only surviving record. It carries the reply (the work),
 * the status (whether the reply can be trusted as finished), and the
 * shape numbers — steps, tool calls, errors, tokens — that let the
 * orchestrator decide whether to merge, re-delegate, or do the part
 * itself without re-reading a transcript it no longer has.
 */
export type WorkerTaskStatus =
  "ok" | "failed" | "cancelled" | "needs_orchestrator" | "max_steps";

/** Which ceiling ended a worker's loop — see `RunTurnResult.stopCause`. */
export type WorkerStopCause = NonNullable<RunTurnResult["stopCause"]>;

export interface WorkerToolStats {
  calls: number;
  errors: number;
  byTool: Record<string, number>;
}

export interface WorkerTaskResult {
  id: string;
  title: string;
  status: WorkerTaskStatus;
  reply: string;
  stepCount: number;
  durationMs: number;
  tools: WorkerToolStats;
  usage?: CompletionUsage;
  /**
   * What went wrong, in the failing layer's own words: the thrown turn,
   * the worker loop's last provider/loop error, or the declared-file
   * check. Rendered on the task's head line.
   */
  error?: string;
  /** What to do about `error`, for a recognised class — `workerFailureHint`. */
  hint?: string;
  /**
   * Non-fatal facts the orchestrator should weigh before merging: a
   * reply written on the forced final step, a declared file the task
   * never touched.
   */
  notes?: string[];
  /**
   * The contract's `checks` attributed to this task, once they ran
   * (`contract-checks.ts`). A failure is also the row's `error`.
   */
  checks?: TaskCheckSummary;
}

export interface TaskCheckSummary {
  total: number;
  failed: number;
  /** The failing checks' verdicts, joined; absent when all passed. */
  detail?: string;
}

/**
 * `checks: 1 of 2 failed — …` / `checks: 2 of 2 passed`. The detail is
 * left off when the row's error already carries it (a task failed BY
 * its checks has `checks: …` as its error), so the verdict reads once.
 */
export function describeChecks(
  checks: TaskCheckSummary,
  cap: number,
  error?: string,
): string {
  if (checks.failed === 0) {
    return `checks: ${checks.total} of ${checks.total} passed`;
  }
  const detail =
    checks.detail === undefined || error?.startsWith("checks: ")
      ? ""
      : ` — ${oneLine(checks.detail, cap)}`;
  return `checks: ${checks.failed} of ${checks.total} failed${detail}`;
}

/**
 * Accumulates one worker turn's observable output from its event hook.
 *
 * The hook is the only channel: `RunTurnResult` gives the reason and
 * the step count but not the reply text, the tool tally, the token
 * usage, or the provider error that killed the turn, and re-deriving
 * them from the returned session would mean walking a transcript that
 * exists purely to be discarded.
 */
export class WorkerRunCollector {
  private replyText = "";
  private approvalRefused = false;
  private calls = 0;
  private errors = 0;
  private readonly byTool: Record<string, number> = {};
  private usage: CompletionUsage | undefined;
  private lastLoopError: string | undefined;
  private lastWaitReason: string | undefined;

  /** Feed one `AgentLoopEvent` from the worker turn's hook. */
  observe(event: AgentLoopEvent): void {
    if (event.type === "loop_failed") {
      // A cancelled turn reports its abort through the same event; that
      // is not a cause, and the status already says `cancelled`.
      if (event.category !== "cancelled") {
        this.lastLoopError = event.error.message;
      }
      return;
    }
    if (event.type === "provider_waiting") {
      // A worker that parks on a dead server and is then cut off by its
      // time limit never reaches `loop_failed`: this is the only record
      // of why its 590 seconds produced nothing.
      this.lastWaitReason = event.reason;
      return;
    }
    if (event.type === "provider_recovered") {
      this.lastWaitReason = undefined;
      return;
    }
    if (event.type !== "llm_event") return;
    const inner = event.event;
    if (inner.type === "assistant_reply") {
      // Last writer wins: an auto-continued turn can emit more than one
      // reply, and the last is the one that ended the work.
      this.replyText = inner.text;
      return;
    }
    if (inner.type === "tool_call_executed") {
      const result = inner.result;
      this.calls += 1;
      this.byTool[result.tool] = (this.byTool[result.tool] ?? 0) + 1;
      if (result.status === "error") this.errors += 1;
      if (resultCarriesApprovalRefusal(result.summary, result.details)) {
        this.approvalRefused = true;
      }
      return;
    }
    if (inner.type === "llm_completed" && inner.completion.usage) {
      const next = inner.completion.usage;
      const prev = this.usage;
      this.usage =
        prev === undefined
          ? { ...next }
          : {
              promptTokens: prev.promptTokens + next.promptTokens,
              completionTokens: prev.completionTokens + next.completionTokens,
              totalTokens: prev.totalTokens + next.totalTokens,
            };
    }
  }

  /** The worker loop's own account of why it stopped working, if any. */
  private failureMessage(): string | undefined {
    if (this.lastLoopError !== undefined) return this.lastLoopError;
    if (this.lastWaitReason !== undefined) {
      return `the provider stopped answering: ${this.lastWaitReason}`;
    }
    return undefined;
  }

  /**
   * Fold the loop's own outcome in and produce the result row.
   *
   * A refusal outranks a clean `reply`: the worker did finish, but it
   * finished by handing an action back, and the orchestrator must not
   * read that as done. It does NOT outrank `failed` / `cancelled` —
   * those say the reply is not even complete.
   *
   * `error` from the caller (a thrown turn, the session's stored error)
   * wins over the collected one; either way a recognised failure class
   * gets its remediation `hint`.
   */
  finish(input: {
    id: string;
    title: string;
    reason: AgentLoopReason | null;
    stepCount: number;
    durationMs: number;
    error?: string;
    stopCause?: WorkerStopCause;
  }): WorkerTaskResult {
    const status = classifyWorkerStatus(
      input.reason,
      this.approvalRefused,
      input.stopCause,
    );
    const error =
      input.error ?? (status === "ok" ? undefined : this.failureMessage());
    const hint = error === undefined ? undefined : workerFailureHint(error);
    const notes =
      input.stopCause !== undefined &&
      status !== "failed" &&
      status !== "cancelled"
        ? [stopCauseNote(input.stopCause, input.stepCount)]
        : [];
    return {
      id: input.id,
      title: input.title,
      status,
      reply: this.replyText,
      stepCount: input.stepCount,
      durationMs: input.durationMs,
      tools: {
        calls: this.calls,
        errors: this.errors,
        byTool: { ...this.byTool },
      },
      ...(this.usage ? { usage: this.usage } : {}),
      ...(error === undefined ? {} : { error }),
      ...(hint === undefined ? {} : { hint }),
      ...(notes.length === 0 ? {} : { notes }),
    };
  }
}

function stopCauseNote(cause: WorkerStopCause, stepCount: number): string {
  if (cause === "time_ceiling") {
    return "stopped at its time limit; any reply was written on the forced final step and may describe work that was not done";
  }
  if (cause === "no_progress") {
    return "stopped after a whole leg of steps made no progress";
  }
  return `stopped at its step limit (${stepCount} steps); the reply was written on the forced final step and may describe work that was not done`;
}

/** Whether a tool result is the worker approval refusal. */
export function resultCarriesApprovalRefusal(
  summary: string,
  details: Record<string, unknown>,
): boolean {
  if (summary.includes(FUSION_WORKER_APPROVAL_MARKER)) return true;
  const reason = details.deniedReason ?? details.reason;
  return (
    typeof reason === "string" && reason.includes(FUSION_WORKER_APPROVAL_MARKER)
  );
}

/**
 * Map a loop reason (or a thrown turn) onto a worker status.
 *
 * `stopCause` is the loop saying a ceiling ended the task. A `reply` on
 * the forced final step is exactly how a worker at 40/40 steps wrote
 * "the step limit was reached before the file write could be executed"
 * and was reported `ok`: the model closed the turn, but only because it
 * was offered nothing else.
 */
export function classifyWorkerStatus(
  reason: AgentLoopReason | null,
  approvalRefused: boolean,
  stopCause?: WorkerStopCause,
): WorkerTaskStatus {
  if (reason === null || reason === "failed") return "failed";
  if (reason === "cancelled") return "cancelled";
  if (approvalRefused) return "needs_orchestrator";
  if (reason === "max_steps" || stopCause !== undefined) return "max_steps";
  return "ok";
}

export const WORKER_HINT_CONTEXT =
  "the local server ran out of context: use fewer workers at once or shorter briefs";
export const WORKER_HINT_SATURATED =
  "the local server was saturated: fewer parallel workers";
export const WORKER_HINT_QUOTA =
  "provider credit/quota exhausted — retrying will not help";

const CONTEXT_EXCEEDED =
  /context size has been exceeded|ran out of context|exceeds? the (?:available )?context|context (?:size|length|window) (?:exceeded|was exceeded)/i;
const SERVER_SATURATED =
  /no first token|first[- ]token timeout|sent no data for \d+\s*ms|idle timeout/i;
const CREDIT_OR_QUOTA =
  /\b402\b|\b429\b|payment required|insufficient (?:credits?|funds|balance|quota)|out of credits?|quota (?:exceeded|exhausted)|exceeded (?:your|the) (?:current )?quota|rate[- ]limit|too many requests/i;

/**
 * A short remediation for a worker failure the orchestrator (or the
 * operator reading its reply) can act on, or `undefined` when the
 * message is not one of the recognised classes.
 *
 * Matched on the message text because that is what survives: the
 * llama-server body (`Context size has been exceeded`), atag's own
 * transport deadlines (`sent no first token within …`), and a cloud
 * gateway's 402 / 429.
 */
export function workerFailureHint(message: string): string | undefined {
  if (SERVER_SATURATED.test(message)) return WORKER_HINT_SATURATED;
  if (CONTEXT_EXCEEDED.test(message)) return WORKER_HINT_CONTEXT;
  if (CREDIT_OR_QUOTA.test(message)) return WORKER_HINT_QUOTA;
  return undefined;
}

const NO_REPLY = "(the worker produced no reply)";

/** How much of an error the head line carries; the rest is noise. */
const ERROR_HEAD_CHARS = 400;

/**
 * Render the results as the tool's `summary`.
 *
 * A status table first: one line per task with its status, error head
 * and notes. A reader that sees only the start of this result — a prompt
 * renders tool results through a character cap — still sees every task's
 * outcome and warnings. Without it a seven-task fan-out showed its first
 * blocks, and the one task that had changed nothing (its note said so, at
 * the end) passed for `ok`.
 *
 * Then two caps, not one. The per-task cap keeps a single verbose worker
 * from crowding its siblings out of the orchestrator's view — the
 * whole point of the fan-out is that it sees all the parts — and the
 * total cap keeps the block inside the step's tool-result budget.
 * Truncation is always announced inline: a silently clipped result is
 * one the orchestrator merges as if it were whole.
 */
export function formatDelegateOutput(
  results: readonly WorkerTaskResult[],
  charCap: number,
  extra: { contractLine?: string } = {},
): string {
  if (results.length === 0) return "(no tasks were run)";
  const table = renderStatusTable(results, extra.contractLine);
  const room = Math.max(0, charCap - table.length - 4);
  const perTask = Math.max(200, Math.floor(room / results.length));
  const blocks = results.map((r) => renderBlock(r, perTask));
  const joined = [table, ...blocks].join("\n\n");
  if (joined.length <= charCap) return joined;
  return `${joined.slice(0, Math.max(0, charCap - 15))}\n… [truncated]`;
}

/** How much of an error or a note one status-table line carries. */
const TABLE_DETAIL_CHARS = 160;

/**
 * The head line, the contract's verdict when there is one, then one
 * line per task. The contract line sits second because it is the one
 * cross-task fact: a missing provide is a hole between parts, not a
 * property of any single row.
 */
function renderStatusTable(
  results: readonly WorkerTaskResult[],
  contractLine: string | undefined,
): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  const tally = [...counts]
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
  const lines = results.map((r) =>
    [
      `- [${r.id}] ${r.status} — ${r.title}`,
      ...(r.error ? [`error: ${oneLine(r.error, TABLE_DETAIL_CHARS)}`] : []),
      ...(r.checks ? [describeChecks(r.checks, TABLE_DETAIL_CHARS, r.error)] : []),
      ...(r.notes ?? []).map((note) => oneLine(note, TABLE_DETAIL_CHARS)),
    ].join(" — "),
  );
  return [
    `${results.length} task${results.length === 1 ? "" : "s"}: ${tally}`,
    ...(contractLine === undefined ? [] : [contractLine]),
    ...lines,
  ].join("\n");
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * The diagnosis goes ABOVE the reply: the error on the head line, then
 * the hint and notes. A worker that died on its provider has no reply
 * worth the space, and one that claimed work it did not do has a reply
 * that must not be read first.
 */
function renderBlock(result: WorkerTaskResult, perTaskCap: number): string {
  const head =
    `[${result.id}] ${result.status} — ${result.title} ` +
    `(${result.stepCount} steps, ${Math.round(result.durationMs / 1000)}s, ` +
    `${result.tools.calls} tool calls, ${result.tools.errors} errors)` +
    (result.error ? ` — error: ${oneLine(result.error, ERROR_HEAD_CHARS)}` : "");
  const diagnosis = [
    ...(result.hint ? [`hint: ${result.hint}`] : []),
    ...(result.checks
      ? [describeChecks(result.checks, ERROR_HEAD_CHARS, result.error)]
      : []),
    ...(result.notes ?? []).map((note) => `note: ${note}`),
  ];
  const used = [head, ...diagnosis].join("\n").length;
  const bodyCap = Math.max(100, perTaskCap - used);
  const body = result.reply.length > 0 ? result.reply : NO_REPLY;
  const clipped =
    body.length > bodyCap
      ? `${body.slice(0, Math.max(0, bodyCap - 15))}\n… [truncated]`
      : body;
  return [head, ...diagnosis, clipped].join("\n");
}
